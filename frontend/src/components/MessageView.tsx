import { useEffect, useState } from 'react';
import type { Folder, MailApi, Me, Message } from '../api';
import { addressOf, formatDate, formatSize } from '../format';
import type { Draft } from './Compose';

interface Props {
  api: MailApi;
  me: Me;
  /** The mailbox the message belongs to; replies are sent from it. */
  mailbox: string;
  id: string;
  onClose: () => void;
  /** Called after the message was moved or deleted. */
  onChanged: (notice: string) => void;
  /** Called after the message was marked as read. */
  onRead: () => void;
  onCompose: (draft: Draft) => void;
}

export function MessageView({ api, me, mailbox, id, onClose, onChanged, onRead, onCompose }: Props) {
  const [message, setMessage] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(mailbox, id)
      .then(async (loaded) => {
        if (cancelled) return;
        setMessage(loaded);
        if (!loaded.read) {
          await api.update(mailbox, id, { read: true });
          onRead();
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [api, mailbox, id]);

  if (error) return <p className="error">{error}</p>;
  if (!message) return <p className="muted">Loading…</p>;

  const act = async (action: () => Promise<unknown>, notice: string) => {
    setBusy(true);
    try {
      await action();
      onChanged(notice);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const move = (folder: Folder, notice: string) => act(() => api.update(mailbox, id, { folder }), notice);

  return (
    <article className="message">
      <div className="toolbar">
        <button onClick={onClose}>← Back</button>
        <button onClick={() => onCompose(replyDraft(message, me, mailbox, false))}>Reply</button>
        <button onClick={() => onCompose(replyDraft(message, me, mailbox, true))}>Reply all</button>
        <button onClick={() => onCompose(forwardDraft(message, mailbox))}>Forward</button>
        <button disabled={busy} onClick={() => act(() => api.update(mailbox, id, { read: false }), 'Marked as unread.')}>
          Mark unread
        </button>
        {message.folder === 'JUNK' && (
          <button disabled={busy} onClick={() => move('INBOX', 'Moved to Inbox.')}>
            Not junk
          </button>
        )}
        {message.folder === 'INBOX' && (
          <button disabled={busy} onClick={() => move('JUNK', 'Moved to Junk.')}>
            Junk
          </button>
        )}
        {message.folder === 'TRASH' ? (
          <>
            <button disabled={busy} onClick={() => move('INBOX', 'Restored to Inbox.')}>
              Restore
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => window.confirm('Delete this message forever?') && act(() => api.remove(mailbox, id), 'Message deleted.')}
            >
              Delete forever
            </button>
          </>
        ) : (
          <button className="danger" disabled={busy} onClick={() => move('TRASH', 'Moved to Trash.')}>
            Delete
          </button>
        )}
      </div>

      <h2>{message.subject || '(no subject)'}</h2>
      <dl className="headers">
        <dt>From</dt>
        <dd>{message.from}</dd>
        <dt>To</dt>
        <dd>{message.to.join(', ')}</dd>
        {message.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{message.cc.join(', ')}</dd>
          </>
        )}
        {message.bcc && message.bcc.length > 0 && (
          <>
            <dt>Bcc</dt>
            <dd>{message.bcc.join(', ')}</dd>
          </>
        )}
        <dt>Date</dt>
        <dd>{formatDate(message.date)}</dd>
      </dl>

      {message.folder === 'JUNK' && <p className="notice">This message was classified as junk. Be careful with links and requests.</p>}
      {message.hasHtml && <p className="notice muted">This message has HTML content; it is shown as plain text.</p>}

      <pre className="body">{message.text || '(empty message)'}</pre>

      {message.attachments.length > 0 && (
        <div className="attachments">
          <h3>Attachments</h3>
          <p className="muted">Downloading attachments is not supported yet.</p>
          <ul>
            {message.attachments.map((attachment, index) => (
              <li key={index}>
                {attachment.filename} <span className="muted">({attachment.contentType}, {formatSize(attachment.size)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function prefixed(prefix: string, subject: string): string {
  return new RegExp(`^${prefix}:`, 'i').test(subject) ? subject : `${prefix}: ${subject}`;
}

function quote(message: Message): string {
  const quoted = message.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n\nOn ${formatDate(message.date)}, ${message.from} wrote:\n${quoted}`;
}

function replyDraft(message: Message, me: Me, mailbox: string, all: boolean): Draft {
  // None of the user's own mailboxes (own or collective) should be copied on a reply.
  const own = new Set(me.mailboxes.map((address) => address.toLowerCase()));
  const sentByMe = addressOf(message.from) === mailbox.toLowerCase();
  const primary = sentByMe ? message.to : message.replyTo.length > 0 ? message.replyTo : [message.from];
  const others = all ? [...message.to, ...message.cc] : [];
  const seen = new Set(primary.map(addressOf));
  const cc = others.filter((entry) => {
    const address = addressOf(entry);
    if (own.has(address) || seen.has(address)) return false;
    seen.add(address);
    return true;
  });
  return {
    from: mailbox,
    to: primary.join(', '),
    cc: cc.join(', '),
    bcc: '',
    subject: prefixed('Re', message.subject),
    text: quote(message),
    inReplyTo: message.id,
  };
}

function forwardDraft(message: Message, mailbox: string): Draft {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${message.from}`,
    `Date: ${formatDate(message.date)}`,
    `Subject: ${message.subject}`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length > 0 ? [`Cc: ${message.cc.join(', ')}`] : []),
  ].join('\n');
  return {
    from: mailbox,
    to: '',
    cc: '',
    bcc: '',
    subject: prefixed('Fwd', message.subject),
    text: `\n\n${header}\n\n${message.text}`,
  };
}

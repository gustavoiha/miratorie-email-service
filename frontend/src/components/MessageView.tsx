import { useEffect, useState } from 'react';
import type { Folder, MailApi, Me, Message } from '../api';
import { type Draft, forwardDraft, replyDraft } from '../drafts';
import { formatDate, formatSize } from '../format';
import { HtmlBody, hasRemoteContent } from './HtmlBody';

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
  const [showImages, setShowImages] = useState(false);
  const [asText, setAsText] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);

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

  if (error && !message) return <p className="error">{error}</p>;
  if (!message) return <p className="muted">Loading…</p>;

  const act = async (action: () => Promise<unknown>, notice: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged(notice);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const move = (folder: Folder, notice: string) => act(() => api.update(mailbox, id, { folder }), notice);

  const download = async (index: number) => {
    setDownloading(index);
    setError(null);
    try {
      const { url } = await api.attachmentUrl(mailbox, id, index);
      // The URL answers with Content-Disposition: attachment, so the page stays where it is.
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloading(null);
    }
  };

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
      {error && <p className="error">{error}</p>}

      {message.html && !asText ? (
        <>
          {hasRemoteContent(message.html) && !showImages && (
            <p className="notice">
              Remote images are hidden, so the sender cannot tell when you open this message.{' '}
              <button className="link inline" onClick={() => setShowImages(true)}>
                Show images
              </button>
            </p>
          )}
          <HtmlBody html={message.html} showImages={showImages} />
        </>
      ) : (
        <pre className="body">{message.text || '(empty message)'}</pre>
      )}
      {message.html && (
        <button className="link body-toggle" onClick={() => setAsText((current) => !current)}>
          {asText ? 'Show formatted' : 'Show as plain text'}
        </button>
      )}

      {message.attachments.length > 0 && (
        <div className="attachments">
          <h3>{message.attachments.length === 1 ? '1 attachment' : `${message.attachments.length} attachments`}</h3>
          <ul>
            {message.attachments.map((attachment, index) => (
              <li key={index}>
                <button className="link" disabled={downloading !== null} onClick={() => download(index)} title={`Download ${attachment.filename}`}>
                  {downloading === index ? 'Preparing…' : `⬇ ${attachment.filename}`}
                </button>{' '}
                <span className="muted">{formatSize(attachment.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

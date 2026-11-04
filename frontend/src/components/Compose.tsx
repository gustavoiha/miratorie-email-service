import { type FormEvent, useState } from 'react';
import type { MailApi, Me } from '../api';

export interface Draft {
  /** Mailbox to send from: one of `Me.mailboxes`. */
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  /** Id of the message being replied to, for threading headers. */
  inReplyTo?: string;
}

interface Props {
  api: MailApi;
  me: Me;
  initial: Draft;
  onCancel: () => void;
  onSent: () => void;
}

function splitAddresses(value: string): string[] {
  return value.trim() ? [value] : [];
}

export function Compose({ api, me, initial, onCancel, onSent }: Props) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = (name: keyof Draft) => ({
    value: draft[name] ?? '',
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [name]: event.target.value })),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.subject.trim() && !window.confirm('Send without a subject?')) return;
    setSending(true);
    setError(null);
    try {
      await api.send(draft.from, {
        to: splitAddresses(draft.to),
        cc: splitAddresses(draft.cc),
        bcc: splitAddresses(draft.bcc),
        subject: draft.subject,
        text: draft.text,
        inReplyTo: draft.inReplyTo,
      });
      onSent();
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  };

  return (
    <form className="compose" onSubmit={submit}>
      <h2>{draft.inReplyTo ? 'Reply' : 'New message'}</h2>
      <label>
        From
        {/* A reply stays in the mailbox of the message it answers. */}
        <select value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} disabled={me.mailboxes.length < 2 || Boolean(draft.inReplyTo)}>
          {me.mailboxes.map((address) => (
            <option key={address} value={address}>
              {me.name ? `${me.name} <${address}>` : address}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <input {...field('to')} placeholder="alice@example.org, Bob <bob@example.net>" required autoFocus={!draft.to} />
      </label>
      <label>
        Cc
        <input {...field('cc')} />
      </label>
      {showBcc ? (
        <label>
          Bcc
          <input {...field('bcc')} />
        </label>
      ) : (
        <button type="button" className="link" onClick={() => setShowBcc(true)}>
          Add Bcc
        </button>
      )}
      <label>
        Subject
        <input {...field('subject')} maxLength={998} />
      </label>
      <label className="grow">
        Message
        <textarea {...field('text')} rows={16} autoFocus={Boolean(draft.to)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="toolbar">
        <button type="submit" className="primary" disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onCancel} disabled={sending}>
          Discard
        </button>
      </div>
    </form>
  );
}

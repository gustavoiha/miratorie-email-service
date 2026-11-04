import { type FormEvent, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENTS_BYTES, type MailApi, type Me } from '../api';
import type { Draft, ForwardedAttachment } from '../drafts';
import { formatSize } from '../format';
import { RichEditor, type RichEditorHandle } from './RichEditor';

interface Props {
  api: MailApi;
  me: Me;
  initial: Draft;
  onCancel: () => void;
  onSent: () => void;
}

interface PendingAttachment {
  key: number;
  file: File;
  progress: number;
  uploadId?: string;
  error?: string;
  abort: AbortController;
}

const MAX_ATTACHMENTS = 20;

function splitAddresses(value: string): string[] {
  return value.trim() ? [value] : [];
}

let nextKey = 0;

export function Compose({ api, me, initial, onCancel, onSent }: Props) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc));
  const [uploads, setUploads] = useState<PendingAttachment[]>([]);
  const [forwarded, setForwarded] = useState<ForwardedAttachment[]>(initial.forward?.attachments ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<RichEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  // Abandoned uploads stop when the draft is closed.
  useEffect(() => () => uploadsRef.current.forEach((upload) => upload.abort.abort()), []);

  const field = (name: 'to' | 'cc' | 'bcc' | 'subject') => ({
    value: draft[name],
    onChange: (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [name]: event.target.value })),
  });

  const totalBytes = uploads.reduce((sum, upload) => sum + upload.file.size, 0) + forwarded.reduce((sum, attachment) => sum + attachment.size, 0);
  const uploading = uploads.some((upload) => !upload.uploadId && !upload.error);

  const patchUpload = (key: number, changes: Partial<PendingAttachment>) =>
    setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...changes } : upload)));

  const addFiles = (files: File[]) => {
    setError(null);
    if (uploads.length + forwarded.length + files.length > MAX_ATTACHMENTS) {
      setError(`At most ${MAX_ATTACHMENTS} attachments per message.`);
      return;
    }
    if (totalBytes + files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENTS_BYTES) {
      setError(`Attachments may add up to ${formatSize(MAX_ATTACHMENTS_BYTES)} per message.`);
      return;
    }
    const added = files.map((file) => ({ key: nextKey++, file, progress: 0, abort: new AbortController() }));
    setUploads((current) => [...current, ...added]);
    for (const upload of added) {
      api
        .upload(upload.file, (progress) => patchUpload(upload.key, { progress }), upload.abort.signal)
        .then((uploadId) => patchUpload(upload.key, { uploadId, progress: 1 }))
        .catch((err: Error) => !upload.abort.signal.aborted && patchUpload(upload.key, { error: err.message }));
    }
  };

  const removeUpload = (key: number) => {
    uploads.find((upload) => upload.key === key)?.abort.abort();
    setUploads((current) => current.filter((upload) => upload.key !== key));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (uploading) return;
    if (uploads.some((upload) => upload.error)) {
      setError('Remove the attachments that failed to upload, or attach them again.');
      return;
    }
    if (!draft.subject.trim() && !window.confirm('Send without a subject?')) return;
    if (editorRef.current?.isEmpty() && uploads.length + forwarded.length === 0 && !window.confirm('Send an empty message?')) return;
    setSending(true);
    setError(null);
    try {
      await api.send(draft.from, {
        to: splitAddresses(draft.to),
        cc: splitAddresses(draft.cc),
        bcc: splitAddresses(draft.bcc),
        subject: draft.subject,
        html: editorRef.current?.html() ?? '',
        inReplyTo: draft.inReplyTo,
        attachments: uploads.map((upload) => ({
          id: upload.uploadId!,
          filename: upload.file.name,
          contentType: upload.file.type || 'application/octet-stream',
        })),
        forward: draft.forward && forwarded.length > 0 ? { id: draft.forward.id, attachments: forwarded.map((attachment) => attachment.index) } : undefined,
      });
      onSent();
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  };

  // Replies and forwards stay in the mailbox of the original message.
  const fromLocked = me.mailboxes.length < 2 || Boolean(draft.inReplyTo) || Boolean(draft.forward);

  return (
    <form className="compose" onSubmit={submit}>
      <h2>{draft.inReplyTo ? 'Reply' : draft.forward ? 'Forward' : 'New message'}</h2>
      <label>
        From
        <select value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} disabled={fromLocked}>
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

      <RichEditor ref={editorRef} initialHtml={initial.html} autoFocus={Boolean(draft.to)} onFiles={addFiles} />

      {(uploads.length > 0 || forwarded.length > 0) && (
        <ul className="attachment-chips" aria-label="Attachments">
          {forwarded.map((attachment) => (
            <li key={`fwd-${attachment.index}`} className="chip">
              <span className="chip-name">{attachment.filename}</span>
              <span className="muted">{formatSize(attachment.size)}</span>
              <button type="button" className="link" aria-label={`Remove ${attachment.filename}`} onClick={() => setForwarded((current) => current.filter((item) => item !== attachment))}>
                ✕
              </button>
            </li>
          ))}
          {uploads.map((upload) => (
            <li key={upload.key} className={upload.error ? 'chip failed' : 'chip'}>
              <span className="chip-name">{upload.file.name}</span>
              <span className="muted">
                {upload.error ? upload.error : upload.uploadId ? formatSize(upload.file.size) : `${Math.round(upload.progress * 100)}%`}
              </span>
              {!upload.uploadId && !upload.error && <progress value={upload.progress} max={1} />}
              <button type="button" className="link" aria-label={`Remove ${upload.file.name}`} onClick={() => removeUpload(upload.key)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="error">{error}</p>}
      <div className="toolbar">
        <button type="submit" className="primary" disabled={sending || uploading}>
          {sending ? 'Sending…' : uploading ? 'Uploading…' : 'Send'}
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending}>
          Attach files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        <button type="button" onClick={onCancel} disabled={sending}>
          Discard
        </button>
        {totalBytes > 0 && <span className="muted">{formatSize(totalBytes)} of {formatSize(MAX_ATTACHMENTS_BYTES)}</span>}
      </div>
    </form>
  );
}

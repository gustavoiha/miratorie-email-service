import type { AppConfig } from './config';

export type Folder = 'INBOX' | 'SENT' | 'JUNK' | 'TRASH';

export const FOLDER_LABELS: Record<Folder, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  JUNK: 'Junk',
  TRASH: 'Trash',
};

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageSummary {
  id: string;
  folder: Folder;
  from: string;
  to: string[];
  cc: string[];
  bcc?: string[];
  subject: string;
  snippet: string;
  date: string;
  read: boolean;
  size: number;
  /** In MIME order: an attachment's index is how it is downloaded. */
  attachments: Attachment[];
}

export interface Message extends MessageSummary {
  replyTo: string[];
  text: string;
  /** Sanitised HTML body, when the message has one. Render it only through `HtmlBody`. */
  html?: string;
}

export interface MessagePage {
  messages: MessageSummary[];
  cursor?: string;
}

export interface Me {
  /** The default mailbox: the user's own address, else their first collective one. */
  mailbox: string;
  /** Every mailbox the user can read and send from, including collective addresses. */
  mailboxes: string[];
  name: string;
  domain: string;
}

export interface OutgoingMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** HTML fragment from the editor; the server sanitises it and derives the text part. */
  html: string;
  inReplyTo?: string;
  /** Finished uploads. */
  attachments: Array<{ id: string; filename: string; contentType: string }>;
  /** Attachments (by index) of a message in the same mailbox, to send along. */
  forward?: { id: string; attachments: number[] };
}

/** A presigned POST to S3 for one attachment. */
export interface Upload {
  id: string;
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
}

/** Same limit as the API: the total of a message's attachments. */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function messagePath(mailbox: string, id: string, suffix = ''): string {
  return `/messages/${encodeURIComponent(id)}${suffix}?${new URLSearchParams({ mailbox })}`;
}

export class MailApi {
  constructor(
    private readonly config: AppConfig,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  me(): Promise<Me> {
    return this.request('GET', '/me');
  }

  list(mailbox: string, folder: Folder, cursor?: string): Promise<MessagePage> {
    const params = new URLSearchParams({ mailbox, folder, limit: '25' });
    if (cursor) params.set('cursor', cursor);
    return this.request('GET', `/messages?${params}`);
  }

  get(mailbox: string, id: string): Promise<Message> {
    return this.request('GET', messagePath(mailbox, id));
  }

  update(mailbox: string, id: string, changes: { read?: boolean; folder?: Folder }): Promise<MessageSummary> {
    return this.request('PATCH', messagePath(mailbox, id), changes);
  }

  remove(mailbox: string, id: string): Promise<void> {
    return this.request('DELETE', messagePath(mailbox, id));
  }

  /** A short-lived URL that downloads the attachment. */
  attachmentUrl(mailbox: string, id: string, index: number): Promise<{ url: string; filename: string }> {
    return this.request('GET', messagePath(mailbox, id, `/attachments/${index}`));
  }

  /** Uploads a file for a message about to be sent; resolves with the upload id. */
  async upload(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
    const contentType = file.type || 'application/octet-stream';
    const upload = await this.request<Upload>('POST', '/attachments', { contentType, size: file.size });
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', file);

    // XMLHttpRequest rather than fetch: it reports upload progress.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', upload.url);
      xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'upload_failed', 'The upload failed.')));
      xhr.onerror = () => reject(new ApiError(0, 'upload_failed', 'The upload failed. Check your connection.'));
      xhr.onabort = () => reject(new ApiError(0, 'upload_aborted', 'The upload was cancelled.'));
      signal?.addEventListener('abort', () => xhr.abort());
      xhr.send(form);
    });
    return upload.id;
  }

  /** Sends from `mailbox`, which must be one of `Me.mailboxes`. */
  send(mailbox: string, message: OutgoingMessage): Promise<MessageSummary> {
    return this.request('POST', `/messages?${new URLSearchParams({ mailbox })}`, message);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    if (!token) throw new ApiError(401, 'signed_out', 'Your session has expired. Please sign in again.');

    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;

    const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!response.ok) {
      throw new ApiError(response.status, payload.error ?? 'error', payload.message ?? `Request failed (${response.status}).`);
    }
    return payload as T;
  }
}

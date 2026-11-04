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
  attachments: Attachment[];
}

export interface Message extends MessageSummary {
  replyTo: string[];
  text: string;
  hasHtml: boolean;
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
  text: string;
  inReplyTo?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function messagePath(mailbox: string, id: string): string {
  return `/messages/${encodeURIComponent(id)}?${new URLSearchParams({ mailbox })}`;
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

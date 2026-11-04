import { useEffect, useState } from 'react';
import type { Folder, MailApi, MessageSummary } from '../api';
import { displayName, formatDate } from '../format';

interface Props {
  api: MailApi;
  mailbox: string;
  folder: Folder;
  selectedId: string | null;
  refreshKey: number;
  onOpen: (id: string) => void;
}

export function MessageList({ api, mailbox, folder, selectedId, refreshKey, onOpen }: Props) {
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .list(mailbox, folder)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setCursor(page.cursor);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, mailbox, folder, refreshKey, reloadKey]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await api.list(mailbox, folder, cursor);
      setMessages((current) => [...current, ...page.messages]);
      setCursor(page.cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="list-header">
        <span className="muted">{loading ? 'Loading…' : `${messages.length}${cursor ? '+' : ''} messages`}</span>
        <button onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!loading && !error && messages.length === 0 && <p className="muted empty">No messages.</p>}
      <ul className="messages">
        {messages.map((message) => {
          const counterpart = folder === 'SENT' ? `To: ${message.to.map(displayName).join(', ')}` : displayName(message.from);
          const classes = ['message-row', message.read ? '' : 'unread', message.id === selectedId ? 'selected' : ''].join(' ');
          return (
            <li key={message.id}>
              <button className={classes} onClick={() => onOpen(message.id)}>
                <span className="row-top">
                  <span className="from">{counterpart}</span>
                  <span className="date">{formatDate(message.date, true)}</span>
                </span>
                <span className="subject">
                  {message.subject || '(no subject)'}
                  {message.attachments.length > 0 && ' 📎'}
                </span>
                <span className="snippet">{message.snippet}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {cursor && (
        <button className="load-more" onClick={loadMore} disabled={loading}>
          Load more
        </button>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, FOLDER_LABELS, type Folder, MailApi, type Me } from './api';
import { getIdToken, handleRedirect, signIn, signOut } from './auth';
import { type AppConfig, loadConfig } from './config';
import { Compose } from './components/Compose';
import { MessageList } from './components/MessageList';
import { MessageView } from './components/MessageView';
import { type Draft, emptyDraft } from './drafts';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string; config?: AppConfig }
  | { status: 'signed-out'; config: AppConfig }
  | { status: 'no-access'; config: AppConfig; message: string }
  | { status: 'ready'; config: AppConfig; api: MailApi; me: Me };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let config: AppConfig | undefined;
      try {
        config = await loadConfig();
        await handleRedirect(config);
        const cfg = config;
        if (!(await getIdToken(cfg))) {
          if (!cancelled) setState({ status: 'signed-out', config: cfg });
          return;
        }
        const api = new MailApi(cfg, () => getIdToken(cfg));
        const me = await api.me();
        if (!cancelled) setState({ status: 'ready', config: cfg, api, me });
      } catch (error) {
        if (cancelled) return;
        if (config && error instanceof ApiError && error.status === 403) {
          setState({ status: 'no-access', config, message: error.message });
        } else if (config && error instanceof ApiError && error.status === 401) {
          setState({ status: 'signed-out', config });
        } else {
          setState({ status: 'error', config, message: (error as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  switch (state.status) {
    case 'loading':
      return <div className="centered">Loading…</div>;
    case 'error':
      return (
        <div className="centered card">
          <h1>Something went wrong</h1>
          <p className="error">{state.message}</p>
          {state.config && <button onClick={() => signIn(state.config!)}>Sign in again</button>}
        </div>
      );
    case 'signed-out':
      return (
        <div className="centered card">
          <h1>{state.config.mailDomain} mail</h1>
          <p>Sign in with the account your administrator created for you.</p>
          <button className="primary" onClick={() => signIn(state.config)}>
            Sign in
          </button>
        </div>
      );
    case 'no-access':
      return (
        <div className="centered card">
          <h1>No access</h1>
          <p>{state.message}</p>
          <p>Ask the administrator of {state.config.mailDomain} to add you to the email users group.</p>
          <button onClick={() => signOut(state.config)}>Sign out</button>
        </div>
      );
    case 'ready':
      return <Mailbox config={state.config} api={state.api} me={state.me} />;
  }
}

const FOLDERS: Folder[] = ['INBOX', 'SENT', 'JUNK', 'TRASH'];

function Mailbox({ config, api, me }: { config: AppConfig; api: MailApi; me: Me }) {
  const [mailbox, setMailbox] = useState(me.mailbox);
  const [folder, setFolder] = useState<Folder>('INBOX');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const openFolder = (next: Folder) => {
    setFolder(next);
    setSelectedId(null);
    setDraft(null);
  };
  const openMailbox = (next: string) => {
    setMailbox(next);
    openFolder('INBOX');
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const content = useMemo(() => {
    if (draft) {
      return (
        <Compose
          api={api}
          me={me}
          initial={draft}
          onCancel={() => setDraft(null)}
          onSent={() => {
            setDraft(null);
            setNotice('Message sent.');
            refresh();
          }}
        />
      );
    }
    if (selectedId) {
      return (
        <MessageView
          key={`${mailbox}/${selectedId}`}
          api={api}
          me={me}
          mailbox={mailbox}
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={(message) => {
            setNotice(message);
            setSelectedId(null);
            refresh();
          }}
          onRead={refresh}
          onCompose={setDraft}
        />
      );
    }
    return null;
  }, [api, me, mailbox, draft, selectedId, refresh]);

  return (
    <div className="layout">
      <header className="topbar">
        <strong>{config.mailDomain}</strong>
        <span className="muted">
          {me.name ? `${me.name} · ` : ''}
          {mailbox}
        </span>
        <button onClick={() => signOut(config)}>Sign out</button>
      </header>

      <nav className="sidebar">
        <button className="primary" onClick={() => { setSelectedId(null); setDraft(emptyDraft(mailbox)); }}>
          Compose
        </button>
        {me.mailboxes.length > 1 && (
          <div className="mailboxes">
            <span className="muted section-label">Mailboxes</span>
            {me.mailboxes.map((address) => (
              <button key={address} className={address === mailbox ? 'folder active' : 'folder'} onClick={() => openMailbox(address)} title={address}>
                {address.split('@')[0]}
              </button>
            ))}
            <span className="muted section-label">Folders</span>
          </div>
        )}
        {FOLDERS.map((name) => (
          <button key={name} className={name === folder ? 'folder active' : 'folder'} onClick={() => openFolder(name)}>
            {FOLDER_LABELS[name]}
          </button>
        ))}
      </nav>

      <section className={content ? 'list hidden-narrow' : 'list'}>
        <MessageList key={mailbox} api={api} mailbox={mailbox} folder={folder} selectedId={selectedId} refreshKey={refreshKey} onOpen={(id) => { setDraft(null); setSelectedId(id); }} />
      </section>

      <main className={content ? 'detail' : 'detail hidden-narrow'}>{content ?? <p className="muted centered">Select a message.</p>}</main>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

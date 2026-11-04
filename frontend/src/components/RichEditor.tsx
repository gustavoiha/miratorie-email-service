import { type ClipboardEvent, type DragEvent, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface RichEditorHandle {
  /** The edited HTML; the server sanitises it again before sending. */
  html(): string;
  isEmpty(): boolean;
  focus(): void;
}

interface Props {
  initialHtml: string;
  autoFocus?: boolean;
  /** Files dropped or pasted into the editor become attachments instead of inline content. */
  onFiles: (files: File[]) => void;
}

type Command = { label: string; title: string; run: () => void };

/**
 * A deliberately small rich-text editor on contentEditable: bold, italic, underline, lists, quote
 * and links. Pasted content is inserted as plain text, so no foreign markup or remote images get in.
 */
export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ initialHtml, autoFocus, onFiles }, ref) {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const editor = editorRef.current!;
    // Set once: React must not re-render the content the user is editing.
    editor.innerHTML = initialHtml;
    document.execCommand('defaultParagraphSeparator', false, 'p');
    if (autoFocus) {
      editor.focus();
      // Caret at the start, above any quoted text.
      const range = document.createRange();
      range.setStart(editor, 0);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    html: () => editorRef.current?.innerHTML ?? '',
    isEmpty: () => !editorRef.current?.textContent?.trim(),
    focus: () => editorRef.current?.focus(),
  }));

  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
  };

  const commands: Command[] = [
    { label: 'B', title: 'Bold (Ctrl/⌘+B)', run: () => exec('bold') },
    { label: 'I', title: 'Italic (Ctrl/⌘+I)', run: () => exec('italic') },
    { label: 'U', title: 'Underline (Ctrl/⌘+U)', run: () => exec('underline') },
    { label: '• List', title: 'Bulleted list', run: () => exec('insertUnorderedList') },
    { label: '1. List', title: 'Numbered list', run: () => exec('insertOrderedList') },
    { label: '❝ Quote', title: 'Quote', run: () => exec('formatBlock', 'blockquote') },
    {
      label: 'Link',
      title: 'Link the selected text',
      run: () => {
        const url = window.prompt('Link address (https://…, mailto:…)', 'https://');
        if (!url) return;
        if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) {
          window.alert('Only https://, http:// and mailto: links are allowed.');
          return;
        }
        exec('createLink', url.trim());
      },
    },
    {
      label: 'Clear',
      title: 'Remove formatting',
      run: () => {
        exec('removeFormat');
        exec('unlink');
      },
    },
  ];

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      onFiles(files);
      return;
    }
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    // Only files may be dropped (as attachments); dropped markup is refused like pasted markup.
    event.preventDefault();
    if (event.dataTransfer.files.length > 0) onFiles([...event.dataTransfer.files]);
    else document.execCommand('insertText', false, event.dataTransfer.getData('text/plain'));
  };

  return (
    <div className="editor">
      <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
        {commands.map((command) => (
          // mousedown would move the focus (and selection) out of the editor.
          <button key={command.label} type="button" title={command.title} onMouseDown={(event) => event.preventDefault()} onClick={command.run}>
            {command.label}
          </button>
        ))}
      </div>
      <div
        ref={editorRef}
        className="editor-content"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        onPaste={onPaste}
        onDrop={onDrop}
        suppressContentEditableWarning
      />
    </div>
  );
});

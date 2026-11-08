export default function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }) {
  return (
    <div className="scrim" data-testid="dialog-scrim">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title" data-testid="dialog-title">{title}</h2>
        <p className="muted" data-testid="dialog-body">{body}</p>
        <div className="dialog-actions">
          <button className="btn btn-quiet" data-testid="dialog-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" data-testid="dialog-confirm" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCart, money } from '../data.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

export default function Cart() {
  const [items, setItems] = useState(null);
  const [removing, setRemoving] = useState(null);

  useEffect(() => {
    let live = true;
    fetchCart().then((data) => live && setItems(data));
    return () => {
      live = false;
    };
  }, []);

  if (!items) return <p className="muted" data-testid="loading">Loading your cart…</p>;

  const subtotal = items.reduce((sum, i) => sum + i.price, 0);
  return (
    <section>
      <h1>Your cart</h1>
      <ul className="items">
        {items.map((item) => (
          <li key={item.id} className="item" data-testid={`item-${item.id}`}>
            <div>
              <p className="item-name">{item.name}</p>
              <p className="muted">{item.detail}</p>
            </div>
            <span className="item-price">{money(item.price)}</span>
            <button className="btn btn-quiet" data-testid={`remove-${item.id}`} onClick={() => setRemoving(item)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="summary">
        <span>Subtotal</span>
        <strong data-testid="subtotal">{money(subtotal)}</strong>
      </div>
      <Link to="/checkout" className="btn" data-testid="to-checkout">Continue to checkout</Link>

      {removing && (
        <ConfirmDialog
          title="Remove item?"
          body="This can't be undone."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setItems(items.filter((i) => i.id !== removing.id));
            setRemoving(null);
          }}
        />
      )}
    </section>
  );
}

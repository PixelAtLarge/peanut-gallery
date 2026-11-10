import { useState } from 'react';
import { money } from '../data.js';

const PROMOS = { PLANTS10: 0.1 };

export default function Checkout() {
  const subtotal = 104;
  const [code, setCode] = useState('');
  const [applied, setApplied] = useState(null);
  const [error, setError] = useState('');
  const total = applied ? subtotal * (1 - PROMOS[applied]) : subtotal;

  const apply = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (PROMOS[c]) {
      setApplied(c);
      setError('');
    } else {
      setApplied(null);
      setError(`“${code.trim()}” isn't a valid code`);
    }
  };

  return (
    <section>
      <h1>Checkout</h1>
      <form className="promo" onSubmit={apply}>
        <label>
          Promo code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. PLANTS10" data-testid="promo" />
        </label>
        <button className="btn" data-testid="apply-promo">Apply</button>
      </form>
      {applied && <p className="promo-note" data-testid="promo-applied">{applied} applied: 10% off</p>}
      {error && <p className="promo-error" data-testid="promo-error">{error}</p>}
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <label>
          Email
          <input type="email" placeholder="you@example.com" data-testid="email" />
        </label>
        <label>
          Shipping address
          <input placeholder="Street, city, ZIP" data-testid="address" />
        </label>
        <div className="summary">
          <span>Total</span>
          <span data-testid="total">{money(total)}</span>
        </div>
        <button className="btn" data-testid="pay">Pay now</button>
      </form>
    </section>
  );
}

import { money } from '../data.js';

export default function Checkout() {
  const total = 104;
  return (
    <section>
      <h1>Checkout</h1>
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

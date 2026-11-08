import { NavLink, Route, Routes } from 'react-router-dom';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Greenhouse</span>
        <nav className="nav">
          <NavLink to="/" end data-testid="nav-cart">Cart</NavLink>
          <NavLink to="/checkout" data-testid="nav-checkout">Checkout</NavLink>
        </nav>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<Cart />} />
          <Route path="/checkout" element={<Checkout />} />
        </Routes>
      </main>
    </div>
  );
}

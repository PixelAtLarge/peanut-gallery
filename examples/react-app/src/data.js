const ITEMS = [
  { id: 'fiddle', name: 'Fiddle leaf fig', detail: '10" nursery pot', price: 48 },
  { id: 'snake', name: 'Snake plant', detail: '6" ceramic pot', price: 32 },
  { id: 'pothos', name: 'Golden pothos', detail: 'Hanging basket', price: 24 },
];

/** Pretend network request, so the list renders after the page has loaded. */
export function fetchCart() {
  return new Promise((resolve) => setTimeout(() => resolve(ITEMS.map((i) => ({ ...i }))), 350));
}

export const money = (n) => `$${n.toFixed(2)}`;

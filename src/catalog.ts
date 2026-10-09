export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  category: "beans" | "gear";
}

export const products: Product[] = [
  {
    id: "beans-ethiopia",
    name: "Ethiopia Yirgacheffe",
    description: "Washed single origin. Floral, citrus, black tea. 250g whole bean.",
    priceCents: 1850,
    category: "beans",
  },
  {
    id: "beans-colombia",
    name: "Colombia Huila",
    description: "Caramel sweetness, red apple, cocoa finish. 250g whole bean.",
    priceCents: 1650,
    category: "beans",
  },
  {
    id: "beans-decaf",
    name: "Sugarcane Decaf",
    description: "EA-process decaf from Colombia. Honey, almond, clean cup. 250g.",
    priceCents: 1700,
    category: "beans",
  },
  {
    id: "gear-v60",
    name: "Ceramic Dripper",
    description: "Classic 02-size pourover cone with spiral ribs.",
    priceCents: 2800,
    category: "gear",
  },
  {
    id: "gear-filters",
    name: "Paper Filters (100)",
    description: "Oxygen-bleached 02-size cone filters.",
    priceCents: 950,
    category: "gear",
  },
  {
    id: "gear-kettle",
    name: "Gooseneck Kettle",
    description: "1L stovetop kettle with precision spout.",
    priceCents: 5400,
    category: "gear",
  },
];

export function getProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

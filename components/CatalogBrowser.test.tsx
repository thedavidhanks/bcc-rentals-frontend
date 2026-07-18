import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CatalogBrowser } from "@/components/CatalogBrowser";
import type { Product, ProductCategory } from "@/lib/products/types";

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    slug: "tent",
    name: "Tent",
    type: "unique",
    totalStock: 1,
    shortDescription: "A tent",
    longDescription: "A big tent",
    highlights: [],
    image: null,
    unit: "full-day",
    pricing: { kind: "flat-per-day", cents: 15000, minDays: 1 },
    prices: [],
    categories: [],
    bookingWindow: { minLeadHours: 0, maxAdvanceDays: 365 },
    bufferMinutes: 0,
    ...overrides,
  };
}

const ROOM: ProductCategory = { slug: "room", name: "Room" };
const EVENT: ProductCategory = { slug: "event-add-on", name: "Event add-on" };
const ACCESSORY: ProductCategory = { slug: "accessory", name: "Accessory" };
const TOOL: ProductCategory = { slug: "tool", name: "Tool" };

// A representative catalog: a room, a tool, and a multi-category product (tent)
// that belongs to both Event add-on and Accessory.
const partyRoom = makeProduct({ slug: "party-room", name: "Party Room", categories: [ROOM] });
const powerDrill = makeProduct({ slug: "power-drill", name: "Power Drill", categories: [TOOL] });
const tent = makeProduct({ slug: "tent", name: "Tent", categories: [EVENT, ACCESSORY] });

const products = [partyRoom, powerDrill, tent];
// Include a category (Decor) that no product uses, to prove it gets no pill.
const categories: ProductCategory[] = [
  ROOM,
  TOOL,
  EVENT,
  ACCESSORY,
  { slug: "decor", name: "Decor" },
];

function pill(name: string) {
  return screen.getByRole("button", { name });
}

describe("CatalogBrowser", () => {
  it("shows every product by default under the 'All' pill", () => {
    render(<CatalogBrowser products={products} categories={categories} />);

    expect(screen.getByText("Party Room")).toBeInTheDocument();
    expect(screen.getByText("Power Drill")).toBeInTheDocument();
    expect(screen.getByText("Tent")).toBeInTheDocument();
    expect(pill("All")).toHaveAttribute("aria-pressed", "true");
  });

  it("renders a pill only for categories that have at least one product", () => {
    render(<CatalogBrowser products={products} categories={categories} />);

    expect(pill("All")).toBeInTheDocument();
    expect(pill("Room")).toBeInTheDocument();
    expect(pill("Tool")).toBeInTheDocument();
    expect(pill("Event add-on")).toBeInTheDocument();
    expect(pill("Accessory")).toBeInTheDocument();
    // No product is in "Decor", so no pill for it.
    expect(screen.queryByRole("button", { name: "Decor" })).not.toBeInTheDocument();
  });

  it("filters to only products in the selected category", () => {
    render(<CatalogBrowser products={products} categories={categories} />);

    fireEvent.click(pill("Room"));

    expect(screen.getByText("Party Room")).toBeInTheDocument();
    expect(screen.queryByText("Power Drill")).not.toBeInTheDocument();
    expect(screen.queryByText("Tent")).not.toBeInTheDocument();
    expect(pill("Room")).toHaveAttribute("aria-pressed", "true");
    expect(pill("All")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a multi-category product under each of its categories", () => {
    render(<CatalogBrowser products={products} categories={categories} />);

    fireEvent.click(pill("Event add-on"));
    expect(screen.getByText("Tent")).toBeInTheDocument();
    expect(screen.queryByText("Party Room")).not.toBeInTheDocument();

    fireEvent.click(pill("Accessory"));
    expect(screen.getByText("Tent")).toBeInTheDocument();
    expect(screen.queryByText("Power Drill")).not.toBeInTheDocument();
  });

  it("resets to the full catalog when 'All' is clicked again", () => {
    render(<CatalogBrowser products={products} categories={categories} />);

    fireEvent.click(pill("Tool"));
    expect(screen.queryByText("Party Room")).not.toBeInTheDocument();

    fireEvent.click(pill("All"));
    expect(screen.getByText("Party Room")).toBeInTheDocument();
    expect(screen.getByText("Power Drill")).toBeInTheDocument();
    expect(screen.getByText("Tent")).toBeInTheDocument();
    expect(pill("All")).toHaveAttribute("aria-pressed", "true");
  });
});

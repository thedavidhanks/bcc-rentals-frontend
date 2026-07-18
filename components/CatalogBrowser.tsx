"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ProductCard } from "@/components/ProductCard";
import type { Product, ProductCategory } from "@/lib/products/types";

const ALL = "all";

export function CatalogBrowser({
  products,
  categories,
}: {
  products: Product[];
  categories: ProductCategory[];
}) {
  const [selected, setSelected] = useState<string>(ALL);

  // Only show categories that have at least one product.
  const activeCategories = useMemo(() => {
    const used = new Set<string>();
    for (const product of products) {
      for (const category of product.categories) used.add(category.slug);
    }
    return categories.filter((c) => used.has(c.slug));
  }, [products, categories]);

  const visible = useMemo(() => {
    if (selected === ALL) return products;
    return products.filter((p) => p.categories.some((c) => c.slug === selected));
  }, [products, selected]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <FilterPill
          label="All"
          active={selected === ALL}
          onClick={() => setSelected(ALL)}
        />
        {activeCategories.map((category) => (
          <FilterPill
            key={category.slug}
            label={category.name}
            active={selected === category.slug}
            onClick={() => setSelected(category.slug)}
          />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {visible.map((product) => (
          <ProductCard key={product.slug} product={product} />
        ))}
      </div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/80",
      )}
    >
      {label}
    </button>
  );
}

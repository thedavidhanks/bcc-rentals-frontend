import Link from "next/link";
import { formatCents } from "@/lib/products/pricing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Product } from "@/lib/products/types";

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link href={`/rentals/${product.slug}`}>
      <Card className="h-full transition-shadow hover:shadow-md">
        <CardHeader>
          <CardTitle>{product.name}</CardTitle>
          <CardDescription>{product.shortDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm font-medium">
            {formatCents(product.pricing.cents)}{" "}
            <span className="text-muted-foreground">
              / {product.unit === "full-day" ? "day" : "hour"}
            </span>
          </div>
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            {product.highlights.map((h) => (
              <li key={h}>· {h}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </Link>
  );
}

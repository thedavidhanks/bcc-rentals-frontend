import Link from "next/link";
import { listProducts } from "@/lib/products/repository";
import { formatCents } from "@/lib/products/pricing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function Home() {
  const products = await listProducts();
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Reserve a community rental</h1>
        <p className="text-muted-foreground">
          Pick a date, pay online, and you&apos;re booked. Proceeds support the Bachman Community Center.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {products.map((product) => (
          <Link key={product.slug} href={`/rentals/${product.slug}`}>
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
        ))}
      </section>
    </div>
  );
}

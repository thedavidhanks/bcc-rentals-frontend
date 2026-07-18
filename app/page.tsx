import { listProducts, listCategories } from "@/lib/products/repository";
import { CatalogBrowser } from "@/components/CatalogBrowser";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [products, categories] = await Promise.all([listProducts(), listCategories()]);
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Reserve a community rental</h1>
        <p className="text-muted-foreground">
          Pick a date, pay online, and you&apos;re booked. Proceeds support the Bachman Community Center.
        </p>
      </section>

      <CatalogBrowser products={products} categories={categories} />
    </div>
  );
}

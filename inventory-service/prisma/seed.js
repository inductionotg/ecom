import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial products into inventory...');

  // Product 1: Laptop with 10 units in stock
  await prisma.product.upsert({
    where: { sku: 'SKU-LAPTOP-01' },
    update: {},
    create: {
      id: 'prod_laptop_01',
      sku: 'SKU-LAPTOP-01',
      name: 'MacBook Pro 16"',
      price: 1200.00,
      stockTotal: 10,
      stockReserved: 0,
    },
  });

  // Product 2: Mouse with only 2 units in stock (great for testing race conditions!)
  await prisma.product.upsert({
    where: { sku: 'SKU-MOUSE-02' },
    update: {},
    create: {
      id: 'prod_mouse_02',
      sku: 'SKU-MOUSE-02',
      name: 'Wireless Magic Mouse',
      price: 25.00,
      stockTotal: 2,
      stockReserved: 0,
    },
  });

  console.log('✅ Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
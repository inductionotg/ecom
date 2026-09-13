import { PrismaClient } from '@prisma/client';
import { InventoryService } from '../services/inventoryService.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();
const inventoryService = new InventoryService();

// GET /api/products/:id (Uses Redis Cache-Aside)
export async function getProductHandler(req, res) {
  try {
    const { id } = req.params;
    const product = await inventoryService.getProductById(id);

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.status(200).json({
      success: true,
      data: product,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get product');
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

// GET /api/products (Lists all catalog products)
export async function listProductsHandler(req, res) {
  try {
    const products = await prisma.product.findMany();
    const formatted = products.map((p) => ({
      ...p,
      stockAvailable: p.stockTotal - p.stockReserved,
    }));

    return res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to list products');
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}
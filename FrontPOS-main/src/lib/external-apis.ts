/**
 * External APIs integration for POS system
 * Currently supports: Open Food Facts (Product Images)
 */

export interface OpenFoodFactsProduct {
  product_name?: string;
  image_url?: string;
  image_front_url?: string;
  brands?: string;
}

/**
 * Fetches product information from Open Food Facts API by barcode
 */
export async function fetchProductFromOpenFoodFacts(barcode: string): Promise<OpenFoodFactsProduct | null> {
  if (!barcode || barcode.length < 5) return null;

  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, {
      method: 'GET',
      headers: {
        'User-Agent': 'NeoGeForcePOS - Web - Version 5.1'
      }
    });

    if (!response.ok) return null;

    const data = await response.json();
    
    if (data.status === 1 && data.product) {
      return {
        product_name: data.product.product_name,
        image_url: data.product.image_url || data.product.image_front_url,
        image_front_url: data.product.image_front_url,
        brands: data.product.brands
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching from Open Food Facts:', error);
    return null;
  }
}

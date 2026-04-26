// Motor de Cálculo y Búsqueda Ultra-Instinto (Web Worker)
import { Product } from '../lib/definitions';

interface WorkerState {
    products: Product[];
    searchQuery: string;
    selectedCategory: string;
}

let state: WorkerState = {
    products: [],
    searchQuery: '',
    selectedCategory: 'all'
};

// Función de filtrado optimizada (Búsqueda HFT)
function filterProducts() {
    const query = state.searchQuery.toLowerCase().trim();
    const categoryFilter = state.selectedCategory;

    if (!state.products) return [];

    return state.products.filter(p => {
        const matchesCategory = categoryFilter === 'all' || String(p.categoryId) === categoryFilter;
        if (!matchesCategory) return false;
        if (!query) return true;

        const nameMatch = (p.productName || '').toLowerCase().includes(query);
        const barcodeMatch = (p.barcode || '').includes(query);
        
        return nameMatch || barcodeMatch;
    }).sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
}

// Escuchar mensajes del Main Thread
self.onmessage = (e: MessageEvent) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'SET_PRODUCTS':
            state.products = payload;
            break;
        case 'UPDATE_SEARCH':
            state.searchQuery = payload.query;
            state.selectedCategory = payload.category;
            const filtered = filterProducts();
            self.postMessage({ type: 'FILTERED_PRODUCTS', payload: filtered });
            break;
        case 'CALCULATE_TOTAL':
            const items = payload;
            const total = items.reduce((sum: number, item: any) => {
                const price = Number(item.salePrice) || 0;
                // Simulación de redondeo (applyRounding local)
                const val = price * item.cartQuantity;
                return sum + (Math.round(val / 50) * 50); // Rounding a 50 como en applyRounding
            }, 0);
            self.postMessage({ type: 'TOTAL_CALCULATED', payload: total });
            break;
    }
};

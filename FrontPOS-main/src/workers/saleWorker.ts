// Motor de Calculo y Busqueda Ultra-Instinto (Web Worker)
import { Product } from '../lib/definitions';

interface WorkerState {
    products: Product[];
    searchQuery: string;
    selectedCategory: string;
}

const state: WorkerState = {
    products: [],
    searchQuery: '',
    selectedCategory: 'all'
};

// Funcion de filtrado optimizada (Busqueda HFT)
function filterProducts() {
    const query = state.searchQuery.toLowerCase().trim();
    const categoryFilter = state.selectedCategory;

    if (!state.products) return [];

    return state.products.filter(p => {
        const matchesCategory = categoryFilter === 'all' || String(p.categoryId) === categoryFilter;
        if (!matchesCategory) return false;
        if (!query) return true;

        const nameMatch = (p.productName || '').toLowerCase().includes(query);
        const barcodeMatch = (p.barcode || '').toLowerCase().includes(query);
        const altCodesMatch = (p.alternateCodes || '').toLowerCase().includes(query);
        
        return nameMatch || barcodeMatch || altCodesMatch;
    }).sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
}

// Escuchar mensajes del Main Thread
self.onmessage = (e: MessageEvent) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'SET_PRODUCTS':
            state.products = payload || [];
            const filteredSet = filterProducts();
            self.postMessage({ type: 'FILTERED_PRODUCTS', payload: filteredSet });
            break;
        case 'UPDATE_SEARCH':
            state.searchQuery = payload.query;
            state.selectedCategory = payload.category;
            const filtered = filterProducts();
            self.postMessage({ type: 'FILTERED_PRODUCTS', payload: filtered });
            break;
    }
};

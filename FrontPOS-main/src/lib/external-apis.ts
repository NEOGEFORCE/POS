/**
 * External APIs integration for POS system
 * Currently supports: Legacy structural interfaces (Cleaned)
 */

import { apiFetch } from './api-error';
import Cookies from 'js-cookie';

export interface OpenFoodFactsProduct {
  productName?: string;
  image_url?: string;
}

/**
 * AI Lookup logic removed during Deep Cleaning Sprint.
 * All product management is now 100% manual.
 */

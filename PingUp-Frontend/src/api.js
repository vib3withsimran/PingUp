const BASE_URL = import.meta.env.VITE_API_URL || 'https://pingup-backend-1.onrender.com';

export function getApiUrl(endpoint) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${BASE_URL}${cleanEndpoint}`;
}

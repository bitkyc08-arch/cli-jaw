import { parseJsonObjectOptional } from './args.js';

function resolveFilters(flags) {
  const filters = parseJsonObjectOptional(flags.filters, 'filters');
  if (filters) {
    const entries = {};
    Object.entries(filters).forEach(([key, value]) => {
      entries[key] = String(value);
    });
    return entries;
  }
  if (typeof flags.id === 'string' && flags.id.length > 0) {
    return { id: `eq.${flags.id}` };
  }
  throw new Error('Provide --filters (JSON) or --id');
}

function filtersToQuery(filters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

export {
  resolveFilters,
  filtersToQuery
};

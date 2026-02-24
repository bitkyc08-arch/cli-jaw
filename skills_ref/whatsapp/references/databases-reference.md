# Database Filters Reference

Use PostgREST-style filters as query parameters.

## Operators

- `eq`: equals (`status=eq.active`)
- `neq`: not equal (`status=neq.inactive`)
- `gt`: greater than (`age=gt.18`)
- `gte`: greater or equal (`age=gte.18`)
- `lt`: less than (`price=lt.100`)
- `lte`: less or equal (`price=lte.100`)
- `like`: pattern match (`name=like.%john%`)
- `in`: list match (`status=in.(active,pending)`)
- `is.null`: is null (`deleted_at=is.null`)

## Common patterns

- Select columns: `?select=id,name,email`
- Order: `?order=created_at.desc`
- Pagination: `?limit=20&offset=40`

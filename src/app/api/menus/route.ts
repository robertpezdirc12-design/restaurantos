import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const [items, categories] = await Promise.all([
    db.menuItem.findMany({ include: { category: true }, orderBy: { name: 'asc' } }),
    db.category.findMany({ orderBy: { sortOrder: 'asc' } }),
  ])
  return ok({ items, categories })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return fail('Ni dovoljenj za urejanje menija.', 403)
  const body = await req.json().catch(() => null)
  if (!body?.name || body?.price === undefined) return fail('Ime in cena sta obvezna.')
  const item = await db.menuItem.create({
    data: {
      name: String(body.name),
      price: Number(body.price),
      description: body.description || null,
      categoryId: body.categoryId || null,
      taxRate: Number(body.taxRate) || 9.5,
      station: ['KITCHEN', 'BAR'].includes(body.station) ? body.station : 'KITCHEN',
    },
  })
  return ok({ item }, 201)
}

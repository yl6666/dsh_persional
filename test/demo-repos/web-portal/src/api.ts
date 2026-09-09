const base = 'https://orders.internal'

export async function listOrders(): Promise<unknown[]> {
  const response = await fetch(base + '/orders')
  return (await response.json()) as unknown[]
}

export function ordersUrl(): string {
  return base + '/orders'
}

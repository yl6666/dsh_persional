import { formatAmount } from '@acme/shared-sdk'

export function startServer(port: number): void {
  console.log('orders listening on', port, formatAmount(199))
}

export function publishOrderCancelled(orderId: string, reason: string): void {
  publish('order.cancelled', { orderId, reason })
}

function publish(topic: string, payload: unknown): void {
  void topic
  void payload
}

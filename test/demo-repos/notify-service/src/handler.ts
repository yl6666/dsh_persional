import { formatAmount } from '@acme/shared-sdk'

export function registerHandlers(subscribe: (topic: string, handler: (payload: unknown) => void) => void): void {
  subscribe('order.cancelled', payload => {
    console.log('notify:', formatAmount(0), payload)
  })
}

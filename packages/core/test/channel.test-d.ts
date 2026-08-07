import type { ChannelContract, ChannelHub } from "../src/channel.ts"

declare const channel: ChannelContract<"orders", { readonly id: string }>
declare const hub: ChannelHub

hub.publish(channel, { id: "order-1" })
hub.subscribe(channel)
hub.subscribe(channel, { resumeFrom: "orders:1" })

// @ts-expect-error channel messages are typed end to end
hub.publish(channel, { id: 42 })

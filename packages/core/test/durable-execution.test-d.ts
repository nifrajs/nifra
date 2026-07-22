/** Type-level contract for typed compensation arguments. */
import { defineSaga } from "../src/durable-execution.ts"

export const _typedSaga = defineSaga<
  { orderId: string },
  { reserve: { reservationId: string }; charge: { paymentId: string } }
>({
  name: "checkout",
  async run(saga, input) {
    input.orderId satisfies string
    await saga.step("reserve", { reservationId: "r_1" }, async ({ effectId }) => effectId)
    // @ts-expect-error charge compensation requires a paymentId
    await saga.step("charge", { reservationId: "r_1" }, async () => undefined)
  },
  compensators: {
    reserve(args) {
      args.reservationId satisfies string
    },
    charge(args) {
      args.paymentId satisfies string
    },
  },
})

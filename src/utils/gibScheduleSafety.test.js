import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileScheduledActions } from './gibScheduleSafety.js'

const input = `几个 RO 的进度更新如下：
1. RO 9735：车辆于 8 月 24 日放过来，需要租车，已向客户承诺 8 月 28 日交车。向 Mercedes-Benz Long Beach订购了 2 个部件，预计 8 月 24 日送达
2. RO 9728：客户同样于 8 月 24 日来放车，不需要租车，已承诺 8 月 28 日交车。Lexus Woodlandhills订购的 3 个部件已于 8 月 20 日全部收到并确认
3. RO 9734：客户于 8 月 24 日放车，需要租车，向客户承诺的预计完工时间为 8 月 28 日。向 K&P 订购了 1 个部件，预计 8 月 25 日送达。向 Keyston 订购了 2 个部件，预计 8 月 24 日送达
4. RO 9732：客户有租车需求，预计 8 月 24 日放车，已告知客户维修大概会在 8 月 28 日之前做好。向 Lexus Woodlandhills订购了 10 个部件，预计 8 月 24 日全部收到`

test('corrects future drop-off actions inside each RO scope', () => {
  const actions = ['9735', '9728', '9734', '9732'].flatMap(roNumber => ([
    { type: 'update_dropoff_date', roNumber, dropOffDate: '2026-08-28' },
    { type: 'update_car_status', roNumber, carStatus: 'car_in_shop' },
    { type: 'update_due_date', roNumber, dueDate: '2026-08-28' },
  ]))
  const fixed = reconcileScheduledActions(actions, input, { today: '2026-08-21', knownRoNumbers: ['9735', '9728', '9734', '9732'] })

  for (const roNumber of ['9735', '9728', '9734', '9732']) {
    assert.equal(fixed.find(action => action.roNumber === roNumber && action.type === 'update_dropoff_date').dropOffDate, '2026-08-24')
    assert.equal(fixed.find(action => action.roNumber === roNumber && action.type === 'update_car_status').carStatus, 'pending_dropoff')
    assert.equal(fixed.find(action => action.roNumber === roNumber && action.type === 'update_due_date').dueDate, '2026-08-28')
  }
})

test('keeps a confirmed receipt but converts an expected complete shipment to an order', () => {
  const actions = [
    { type: 'log_parts_received', roNumber: '9728', vendor: 'Lexus Woodland Hills', qtyReceived: 3, totalQty: 3 },
    { type: 'log_parts_received', roNumber: '9732', vendor: 'Lexus Woodland Hills', qtyReceived: 10, totalQty: 10 },
    { type: 'add_note', roNumber: '9732', note: 'Vehicle dropped off on 8/24. All 10 parts from Lexus Woodland Hills received on 8/24.' },
  ]
  const fixed = reconcileScheduledActions(actions, input, { today: '2026-08-21', knownRoNumbers: ['9728', '9732'] })

  assert.equal(fixed[0].type, 'log_parts_received')
  assert.deepEqual(fixed[1], {
    type: 'update_parts_order',
    roNumber: '9732',
    vendor: 'Lexus Woodlandhills',
    vendorFull: 'Lexus Woodlandhills',
    description: 'Parts order',
    qty: 10,
    qtyReceived: 0,
    eta: '2026-08-24',
    status: 'ordered',
  })
  assert.equal(fixed[2].note, 'Vehicle scheduled to drop off on 8/24. Ordered 10 parts from Lexus Woodlandhills, ETA 8/24.')
})

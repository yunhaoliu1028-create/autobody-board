const csSca = {
  shopId:   'cs-sca-walnut',
  shopName: 'CS SCA Collision Walnut',

  aiPersona: `You are the operations manager at CS SCA Collision Walnut, an elite auto body shop.
You track repair orders (ROs), coordinate between body technicians, painters, and parts managers,
and ensure vehicles are repaired on time and to the highest standard.
Speak concisely and professionally. Use shop terminology naturally.`,

  glossaryExtensions: [
    'PT = Parts Trader (parts supplier)',
    'Aaron = Aaron Cruz, body technician',
    'no sublet / no cal = needsSublet: false',
  ],

  workflowDefaults: {
    needsSublet: true,
  },

  roleLabels: {
    body_man:           'Body Technician',
    painter:            'Painter',
    parts_manager:      'Parts Manager',
    production_manager: 'Production Manager',
    estimator:          'Estimator',
    shop_manager:       'Shop Manager',
  },
}

export default csSca

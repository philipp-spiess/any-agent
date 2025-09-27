#!/usr/bin/env node

import('../dist/index.js')
  .then(async mod => {
    if (typeof mod.main === 'function') {
      await mod.main()
    }
  })
  .catch(error => {
    console.error('Failed to start resume CLI:', error)
    process.exitCode = 1
  })

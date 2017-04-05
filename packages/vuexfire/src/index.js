import {
  VUEXFIRE_OBJECT_VALUE,
  VUEXFIRE_ARRAY_INITIALIZE,
  VUEXFIRE_ARRAY_ADD,
  VUEXFIRE_ARRAY_CHANGE,
  VUEXFIRE_ARRAY_MOVE,
  VUEXFIRE_ARRAY_REMOVE,
  VUEXFIRE_MUTATION
} from './types.js'

import {
  createRecord,
  getRef,
  indexForKey,
  getKey,
  isObject
} from './utils/index.js'

const oldmutations = {
  [VUEXFIRE_OBJECT_VALUE] (state, payload) {
    state[payload.key] = payload.record
  },

  [VUEXFIRE_ARRAY_INITIALIZE] (state, payload) {
    state[payload.key] = []
  },

  [VUEXFIRE_ARRAY_ADD] (state, payload) {
    state[payload.key].splice(payload.index, 0, payload.record)
  },

  [VUEXFIRE_ARRAY_CHANGE] (state, payload) {
    state[payload.key].splice(payload.index, 1, payload.record)
  },

  [VUEXFIRE_ARRAY_MOVE] (state, payload) {
    const array = state[payload.key]
    array.splice(payload.newIndex, 0, array.splice(payload.index, 1)[0])
  },

  [VUEXFIRE_ARRAY_REMOVE] (state, payload) {
    state[payload.key].splice(payload.index, 1)
  }
}

const firebaseMutations = {
  [VUEXFIRE_MUTATION] (_, { commit, state, type, ...payload }) {
    oldmutations[type](state, payload)
  }
}

export default function VuexFire (store) {
}

function bindAsObject ({
  key,
  source,
  cancelCallback,
  commit,
  state
}) {
  const cb = source.on('value', function (snapshot) {
    commit(VUEXFIRE_MUTATION, {
      type: VUEXFIRE_OBJECT_VALUE,
      key,
      record: createRecord(snapshot),
      state
    })
  }, cancelCallback)

  // return the listeners that have been setup
  return { value: cb }
}

function bindAsArray ({
  key,
  source,
  cancelCallback,
  listeners,
  commit,
  state
}) {
  // Initialise the array to an empty one
  commit(VUEXFIRE_ARRAY_INITIALIZE, { key })
  const onAdd = source.on('child_added', function (snapshot, prevKey) {
    const array = state[key]
    const index = prevKey ? indexForKey(array, prevKey) + 1 : 0
    commit(VUEXFIRE_ARRAY_ADD, {
      key,
      index,
      record: createRecord(snapshot)
    })
  }, cancelCallback)

  const onRemove = source.on('child_removed', function (snapshot) {
    const array = state[key]
    const index = indexForKey(array, getKey(snapshot))
    commit(VUEXFIRE_ARRAY_REMOVE, {
      key,
      index
    })
  }, cancelCallback)

  const onChange = source.on('child_changed', function (snapshot) {
    const array = state[key]
    const index = indexForKey(array, getKey(snapshot))
    commit(VUEXFIRE_ARRAY_CHANGE, {
      key,
      index,
      record: createRecord(snapshot)
    })
  }, cancelCallback)

  const onMove = source.on('child_moved', function (snapshot, prevKey) {
    const array = state[key]
    const index = indexForKey(array, getKey(snapshot))
    var newIndex = prevKey ? indexForKey(array, prevKey) + 1 : 0
    // TODO refactor + 1
    newIndex += index < newIndex ? -1 : 0
    commit(VUEXFIRE_ARRAY_MOVE, {
      key,
      index,
      newIndex,
      record: createRecord(snapshot)
    })
  }, cancelCallback)

  listeners[key] = {
    child_added: onAdd,
    child_changed: onChange,
    child_removed: onRemove,
    child_moved: onMove
  }
}

export function generateBind ({ commit, state, context }) {
  const listeners = Object.create(null)
  const sources = Object.create(null)
  // Make it work for modules
  if (context && context.commit) commit = context.commit

  function bind (key, source, cancelCallback) {
    if (!isObject(source)) {
      throw new Error('VuexFire: invalid Firebase binding source.')
    }
    if (!(key in state)) {
      throw new Error(`VuexFire: cannot bind undefined property '${key}'. Define it on the state first.`)
    }
    // Unbind if it already exists
    if (key in sources) {
      unbind(key)
    }
    sources[key] = getRef(source)
    if (state[key] && 'length' in state[key]) {
      bindAsArray({ key, source, cancelCallback, commit, state, listeners })
    } else {
      bindAsObject({ key, source, cancelCallback, commit, state, listeners })
    }
  }

  function unbind (key) {
    if (!(key in sources)) {
      throw new Error(`VuexFire: cannot unbind '${key}' because it wasn't bound.`)
    }
    const oldSource = sources[key]
    const oldListeners = listeners[key]
    for (let event in oldListeners) {
      oldSource.off(event, oldListeners[event])
    }
    // clean up
    delete sources[key]
    delete listeners[key]
  }

  return {
    bind,
    unbind
  }
}

// Firebase binding
const bindings = new WeakMap()

function bind ({
  state,
  commit,
  key,
  source,
  options: {
    cancelCallback
  }
}) {
  if (!isObject(source)) {
    throw new Error('VuexFire: invalid Firebase binding source.')
  }
  if (!(key in state)) {
    throw new Error(`VuexFire: cannot bind undefined property '${key}'. Define it on the state first.`)
  }
  // Unbind if it already exists
  let binding = bindings.get(commit)
  if (!binding) {
    binding = {
      sources: Object.create(null),
      listeners: Object.create(null)
    }
    bindings.set(commit, binding)
  }
  if (key in binding.sources) {
    unbind({ commit, key })
  }
  binding.sources[key] = getRef(source)

  // Automatically detects if it should be bound as an array or as an object
  let listener
  if (state[key] && 'length' in state[key]) {
    bindAsArray({ key, source, cancelCallback, commit, state })
  } else {
    listener = bindAsObject({ key, source, cancelCallback, commit, state })
  }

  binding.listeners[key] = listener
}

function unbind ({ commit, key }) {
  let binding = bindings.get(commit)
  if (!binding) {
    binding = {
      sources: Object.create(null),
      listeners: Object.create(null)
    }
    bindings.set(commit, binding)
  }
  if (!(key in binding.sources)) {
    throw new Error(`VuexFire: cannot unbind '${key}' because it wasn't bound.`)
  }
  const oldSource = binding.sources[key]
  const oldListeners = binding.listeners[key]
  for (let event in oldListeners) {
    oldSource.off(event, oldListeners[event])
  }
  // clean up
  delete binding.sources[key]
  delete binding.listeners[key]
}

export function firebaseAction (action) {
  return function firebaseEnhancedActionFn (context, payload) {
    // get the local state and commit. These may be bound to a module
    const { state, commit } = context
    context.bindFirebaseRef = (key, source, options = {}) => {
      bind({ state, commit, key, source, options })
    }
    context.unbindFirebaseRef = (key) => {
      unbind({ commit, key })
    }
    action(context, payload)
  }
}

export { firebaseMutations }

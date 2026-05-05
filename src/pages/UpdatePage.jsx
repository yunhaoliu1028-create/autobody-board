import { useEffect, useState } from 'react'
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore'
import { db } from '../firebase/config'
import AIInputBox from '../components/AIInputBox'

export default function UpdatePage() {
  const [ros,       setRos]       = useState([])
  const [employees, setEmployees] = useState([])

  useEffect(() => {
    const unsubUsers = onSnapshot(collection(db, 'users'), snap => {
      setEmployees(snap.docs.map(d => ({ uid: d.id, ...d.data() })))
    })
    const q = query(collection(db, 'ros'), orderBy('roNumber', 'asc'))
    const unsubRos = onSnapshot(q, snap => {
      setRos(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => { unsubUsers(); unsubRos() }
  }, [])

  return (
    <div className="pb-4">
      <AIInputBox ros={ros} employees={employees} />
    </div>
  )
}

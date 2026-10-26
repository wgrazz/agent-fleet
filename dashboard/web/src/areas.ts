// Area tags: which part of life or work a note belongs to, one per note. The list says what kind of work it is.
// ponytail: fixed list in code, move to a table like lists if areas get edited often
export const AREAS = [
  { name: 'Shopping · Search', color: '#0a84ff' },
  { name: 'Shopping · Data', color: '#5e5ce6' },
  { name: 'Shopping · Features', color: '#64d2ff' },
  { name: 'Growth', color: '#30d158' },
  { name: 'Brand & Design', color: '#ff375f' },
  { name: 'Company', color: '#ff9f0a' },
  { name: 'Setup', color: '#8e8e93' },
  { name: 'Personal', color: '#bf5af2' },
  { name: 'Other ventures', color: '#ac8e68' },
]
export const areaColor = (name: string | null) => AREAS.find(a => a.name === name)?.color

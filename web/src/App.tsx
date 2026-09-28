import { lazy, Suspense } from 'react'
import { parse, usePath } from './lib/router'
import { Home } from './pages/Home'

const RacePage = lazy(() => import('./pages/RacePage'))

export function App() {
  const route = parse(usePath())
  if (route.name === 'race') {
    return (
      <Suspense fallback={<div className="loading" />}>
        <RacePage key={`${route.season}-${route.round}`} season={route.season} round={route.round} />
      </Suspense>
    )
  }
  return <Home />
}

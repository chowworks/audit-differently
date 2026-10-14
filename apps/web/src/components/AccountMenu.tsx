import { useEffect, useRef, useState } from 'react'
import { useClerk, useUser } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { ThemeOptions } from '@/components/ThemePicker'
import { useRole } from '@/hooks/useRole'

/**
 * The account control at the right of the header, in the shape of Learn Differently's: an avatar that
 * opens a short menu. Navigation lives in the top bar, so the menu holds only who you are, Admin tools for a
 * platform admin (as in Learn Differently), the colour theme and Sign out. The release notes, privacy page and
 * contact are in the site footer.
 */
export function AccountMenu() {
  const { user } = useUser()
  const { signOut } = useClerk()
  const { isAdmin } = useRole()
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  return (
    <Menu
      name={user?.fullName ?? email}
      detail={email}
      imageUrl={user?.hasImage ? user.imageUrl : undefined}
      extra={
        isAdmin && (
          <div className="ad-account-group">
            <Link to="/admin" className="ad-account-link">
              Admin tools
            </Link>
          </div>
        )
      }
      footer={
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      }
    />
  )
}

function Menu({
  name,
  detail,
  imageUrl,
  extra,
  footer,
}: {
  name: string
  detail: string
  imageUrl?: string
  extra?: React.ReactNode
  footer?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const first = name.split(' ')[0] || 'Account'

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="ad-account" ref={ref}>
      <button
        type="button"
        className="ad-account-trigger"
        aria-expanded={open}
        aria-controls="ad-account-menu"
        onClick={() => setOpen(!open)}
        data-testid="account"
      >
        {imageUrl ? (
          <img className="ad-account-avatar" src={imageUrl} alt="" />
        ) : (
          <span className="ad-account-avatar" aria-hidden="true">
            {first.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="ad-account-name">{first}</span>
        <span className="ad-account-caret" aria-hidden="true" />
      </button>
      {open && (
        <div id="ad-account-menu" className="ad-account-menu">
          <div className="ad-account-who">
            <strong>{name}</strong>
            <span>{detail}</span>
          </div>
          {/* A choice made here (Admin tools) closes the menu. */}
          {extra && <div onClick={() => setOpen(false)}>{extra}</div>}
          <ThemeOptions />
          <div className="ad-account-out">{footer}</div>
        </div>
      )}
    </div>
  )
}

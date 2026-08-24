import { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Wallet, ArrowLeftRight, Tags, Settings,
  Upload, Wand2, Receipt, BarChart3, PiggyBank, Flame, Calculator, Menu, X, LogOut,
} from 'lucide-react';
import { signOut } from '../lib/auth-client';
import { useAuth } from '../hooks/useAuth';
import { useDemo } from '../hooks/useDemo';
import { LedgerLogo } from './LedgerLogo';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/accounts', icon: Wallet, label: 'Accounts' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Transactions' },
  { to: '/reports', icon: BarChart3, label: 'Reports' },
  { to: '/budget', icon: PiggyBank, label: 'Budget' },
  { to: '/fire', icon: Flame, label: 'FIRE' },
  { to: '/taxes', icon: Calculator, label: 'Taxes' },
  { to: '/categories', icon: Tags, label: 'Categories' },
  { to: '/rules', icon: Wand2, label: 'Rules' },
  { to: '/reimbursements', icon: Receipt, label: 'Reimburse' },
  { to: '/import', icon: Upload, label: 'Import' },
];

const bottomItems = [
  { to: '/settings', icon: Settings, label: 'Settings' },
];

// Mobile bottom nav shows a subset
const mobileNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/accounts', icon: Wallet, label: 'Accounts' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Activity' },
  { to: '/reports', icon: BarChart3, label: 'Reports' },
];

// Items that live in the mobile hamburger drawer
const mobileMenuItems = [
  { to: '/budget', icon: PiggyBank, label: 'Budget' },
  { to: '/fire', icon: Flame, label: 'FIRE' },
  { to: '/taxes', icon: Calculator, label: 'Taxes' },
  { to: '/categories', icon: Tags, label: 'Categories' },
  { to: '/rules', icon: Wand2, label: 'Rules' },
  { to: '/reimbursements', icon: Receipt, label: 'Reimbursements' },
  { to: '/import', icon: Upload, label: 'Import' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

function SidebarIcon({ to, icon: Icon, label, isActive }: {
  to: string; icon: React.ElementType; label: string; isActive: boolean;
}) {
  return (
    <NavLink
      to={to}
      title={label}
      className={`group relative w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-200 ${
        isActive
          ? 'bg-primary/15 text-primary'
          : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
      }`}
    >
      <Icon size={20} strokeWidth={1.5} />
      {/* Tooltip on hover */}
      <span className="absolute left-full ml-2 px-2 py-1 rounded bg-surface-lighter text-xs text-white whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
        {label}
      </span>
    </NavLink>
  );
}

export function Layout() {
  const { user } = useAuth();
  const { isDemoMode } = useDemo();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const closeMenu = useCallback(() => {
    if (!menuOpen || menuClosing) return;
    setMenuClosing(true);
  }, [menuOpen, menuClosing]);

  const onDrawerAnimationEnd = () => {
    if (menuClosing) {
      setMenuClosing(false);
      setMenuOpen(false);
    }
  };

  // Close drawer and reset scroll on navigation
  useEffect(() => {
    if (menuOpen) {
      setMenuClosing(true);
    }
    mainRef.current?.scrollTo(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Lock body scroll and handle Escape when drawer is open
  useEffect(() => {
    if (menuOpen) {
      document.body.style.overflow = 'hidden';
      const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
      document.addEventListener('keydown', handleEscape);
      return () => {
        document.body.style.overflow = '';
        document.removeEventListener('keydown', handleEscape);
      };
    }
  }, [menuOpen, closeMenu]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const getInitials = () => {
    if (!user?.name) return 'U';
    const names = user.name.split(' ');
    return names.length >= 2
      ? `${names[0][0]}${names[1][0]}`.toUpperCase()
      : user.name[0].toUpperCase();
  };

  return (
    <div className="flex h-dvh">
      {/* Desktop sidebar — hidden on mobile */}
      <aside className="hidden md:flex w-[60px] flex-col items-center py-4 bg-sidebar border-r border-border">
        {/* Logo */}
        <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-5">
          <LedgerLogo size={28} />
        </div>

        {/* Main nav */}
        <nav className="flex flex-col gap-1">
          {navItems.map(({ to, icon, label }) => (
            <SidebarIcon
              key={to}
              to={to}
              icon={icon}
              label={label}
              isActive={to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)}
            />
          ))}
        </nav>

        <div className="flex-1" />

        {/* Bottom nav */}
        <nav className="flex flex-col gap-1 mb-1">
          {bottomItems.map(({ to, icon, label }) => (
            <SidebarIcon
              key={to}
              to={to}
              icon={icon}
              label={label}
              isActive={location.pathname.startsWith(to)}
            />
          ))}

          {/* User avatar / logout */}
          <button
            onClick={handleSignOut}
            title="Sign out"
            className="w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-200 text-slate-500 hover:text-slate-300 hover:bg-white/5"
          >
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-medium">
              {getInitials()}
            </div>
          </button>
        </nav>
      </aside>

      {/* Main content */}
      <main ref={mainRef} className="flex-1 overflow-auto scrollbar-hide pb-20 md:pb-0">
        <div className="relative max-w-6xl mx-auto px-4 md:px-6 pt-[calc(1rem_+_env(safe-area-inset-top))] pb-4 md:py-6">
          {/* Mobile hamburger — scrolls with content */}
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            className="md:hidden absolute top-[calc(1rem_+_env(safe-area-inset-top))] right-4 z-30 w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <Menu size={20} strokeWidth={1.5} />
          </button>
          <Outlet key={isDemoMode ? 'demo' : 'live'} />
        </div>
      </main>

      {/* Mobile menu drawer */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation menu">
          {/* Backdrop */}
          <div
            className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${menuClosing ? 'opacity-0' : 'opacity-100'}`}
            onClick={closeMenu}
          />
          {/* Drawer */}
          <div
            className={`absolute right-0 top-0 bottom-0 w-64 bg-sidebar border-l border-border flex flex-col ${menuClosing ? 'animate-slide-out-right' : 'animate-slide-in-right'}`}
            onAnimationEnd={onDrawerAnimationEnd}
          >
            <div className="flex items-center justify-between px-4 py-4">
              <div className="flex items-center gap-2.5">
                <LedgerLogo size={22} />
                <span className="text-sm font-medium text-white">Ledger</span>
              </div>
              <button
                onClick={closeMenu}
                aria-label="Close menu"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <nav className="flex-1 px-3 space-y-0.5">
              {mobileMenuItems.map(({ to, icon: Icon, label }) => {
                const isActive = location.pathname.startsWith(to);
                return (
                  <NavLink
                    key={to}
                    to={to}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-primary/15 text-primary'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Icon size={18} strokeWidth={1.5} />
                    {label}
                  </NavLink>
                );
              })}
            </nav>
            <div className="px-3 pb-4 pt-2 border-t border-border mt-2">
              <button
                onClick={handleSignOut}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-slate-400 hover:text-red-400 hover:bg-red-400/10 transition-colors"
              >
                <LogOut size={18} strokeWidth={1.5} />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-sidebar border-t border-border flex items-center justify-around px-2 pt-2 pb-[calc(0.5rem_+_env(safe-area-inset-bottom))] z-40">
        {mobileNavItems.map(({ to, icon: Icon, label }) => {
          const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
          return (
            <NavLink
              key={to}
              to={to}
              aria-current={isActive ? 'page' : undefined}
              className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors ${
                isActive ? 'text-primary' : 'text-slate-500'
              }`}
            >
              <Icon size={20} strokeWidth={1.5} />
              <span className="text-[10px]">{label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

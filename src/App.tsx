/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { isDeepPage, readEntry, sameNav, type NavState } from './lib/nav-history.ts';
import type { MeResponse } from '../shared/schema.ts';
import { Navbar } from './components/Navbar.tsx';
import { BottomTabBar, type AppTab } from './components/BottomTabBar.tsx';
import { SideNav } from './components/SideNav.tsx';
import { useLayout } from './lib/layout.ts';
import { SignInPage } from './pages/SignInPage.tsx';
import { OnboardingPage } from './pages/OnboardingPage.tsx';
import { FeedPage } from './pages/FeedPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { PostComposerPage } from './pages/PostComposerPage.tsx';
import { ProfileEditPage } from './pages/ProfileEditPage.tsx';
import { ProfileViewPage } from './pages/ProfileViewPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { MessagesPage } from './pages/MessagesPage.tsx';
// DEV-ONLY: remove before launch
import { DevBar } from './components/DevBar.tsx';

/** What the OAuth callback asked for, read once from the URL (/?signup=1 or /?auth=no_account). */
function readAuthRedirect(): { signup: boolean; notice: 'no_account' | 'error' | null } {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  return {
    signup: params.get('signup') === '1',
    notice: auth === 'no_account' || auth === 'error' ? auth : null,
  };
}

export default function App() {
  const layout = useLayout();
  const wide = layout !== 'phone'; // tablet and desktop use the side navigation instead of the bottom bar
  const [authRedirect] = useState(readAuthRedirect);
  const [authNotice, setAuthNotice] = useState<'no_account' | 'error' | null>(authRedirect.notice);
  const [currentUser, setCurrentUser] = useState<MeResponse | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [activeTab, setActiveTab] = useState<AppTab>('feed');
  const [profileSubView, setProfileSubView] = useState<'view' | 'edit'>('view');
  const [viewUsername, setViewUsername] = useState<string>('');
  const [targetMessageUser, setTargetMessageUser] = useState<{
    username: string;
    display_name: string;
    avatar_media_id: string | null;
  } | null>(null);

  // ---- Back button support: every screen change is one history entry ----
  const nav: NavState = { tab: activeTab, sub: profileSubView, user: viewUsername };
  const navRef = useRef(nav);
  navRef.current = nav;
  const idxRef = useRef(0);
  const cameFromBack = useRef(false); // set while rendering the screen reached with Back, so it slides the other way
  useEffect(() => { cameFromBack.current = false; });

  useEffect(() => {
    if (loadingUser) return;
    const entry = readEntry(window.history.state);
    if (!entry) {
      window.history.replaceState({ ...(window.history.state ?? {}), nav, idx: 0 }, '');
      idxRef.current = 0;
      return;
    }
    if (sameNav(entry.nav, nav)) return; // reached by Back/Forward, or nothing changed
    if (nav.tab === 'signin' || nav.tab === 'signup') {
      window.history.replaceState({ nav, idx: entry.idx }, ''); // sign-in screens never pile up in history
      idxRef.current = entry.idx;
    } else {
      window.history.pushState({ nav, idx: entry.idx + 1 }, '');
      idxRef.current = entry.idx + 1;
    }
  }, [activeTab, profileSubView, viewUsername, loadingUser]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const entry = readEntry(e.state);
      if (!entry) return;
      const wasIdx = idxRef.current;
      idxRef.current = entry.idx;
      if (sameNav(entry.nav, navRef.current)) return; // e.g. a sheet closing: same screen
      cameFromBack.current = entry.idx < wasIdx;
      setActiveTab(entry.nav.tab);
      setProfileSubView(entry.nav.sub);
      setViewUsername(entry.nav.user);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** In-app Back: one step back when there is history, otherwise the given fallback screen. */
  const goBack = (fallback: () => void) => {
    if (idxRef.current > 0) window.history.back();
    else fallback();
  };

  const pageClass = cameFromBack.current ? 'page-back' : isDeepPage(nav) ? 'page-forward' : 'page-fade';
  const pageKey = `${nav.tab}:${nav.sub}:${nav.tab === 'profile' ? nav.user : ''}`;

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = (await res.json()) as MeResponse;
        setCurrentUser(data);
        setActiveTab('feed');
      } else {
        setCurrentUser(null);
        // Coming back from Google as a new person: continue with onboarding instead of the sign-in screen
        setActiveTab(authRedirect.signup ? 'signup' : 'signin');
      }
    } catch {
      setCurrentUser(null);
      setActiveTab('signin');
    } finally {
      setLoadingUser(false);
    }
  };

  useEffect(() => {
    // Drop ?signup=1 / ?auth=... from the address bar so a refresh does not repeat the message
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    checkAuth();
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore network errors on logout
    } finally {
      setCurrentUser(null);
      setActiveTab('signin');
    }
  };

  const handleProfileUpdated = (updated: MeResponse) => {
    setCurrentUser(updated);
    setProfileSubView('view');
    setViewUsername(updated.profile.username);
  };

  const handleAccountDeleted = () => {
    setCurrentUser(null);
    setActiveTab('signin');
  };

  const handleViewAuthorProfile = (username: string) => {
    setViewUsername(username);
    setProfileSubView('view');
    setActiveTab('profile');
  };

  if (loadingUser) {
    return (
      <div className="min-h-screen bg-[var(--bg2,#F8F9FC)] flex items-center justify-center p-4">
        <div className="w-full max-w-content min-h-screen bg-[var(--bg,#fff)] p-4 flex flex-col items-center justify-center space-y-3">
          <div className="w-12 h-12 rounded-full skeleton-box mx-auto" />
          <div className="w-32 h-4 skeleton-box rounded mx-auto" />
          <div className="w-24 h-3 skeleton-box rounded mx-auto" />
        </div>
      </div>
    );
  }

  /** Shared by the bottom bar and the side navigation */
  const selectTab = (tab: AppTab) => {
    // Tapping the tab you are already on scrolls back to the top instead of adding a history entry
    const ownProfile = tab !== 'profile' || (profileSubView === 'view' && (viewUsername || currentUser?.profile.username) === currentUser?.profile.username);
    if (tab === activeTab && ownProfile) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (tab === 'profile') {
      setViewUsername(currentUser?.profile.username || '');
      setProfileSubView('view');
    }
    setActiveTab(tab);
  };
  const openMessages = () => {
    setTargetMessageUser(null);
    setActiveTab('messages');
  };

  return (
    <div className="min-h-screen bg-[var(--bg2,#F8F9FC)] text-[var(--text,#17233A)] flex justify-center">
      {wide && currentUser && (
        <SideNav
          activeTab={activeTab}
          setActiveTab={selectTab}
          onOpenMessages={openMessages}
          onTitleClick={() => setActiveTab('feed')}
          expanded={layout === 'desktop'}
        />
      )}
      <div className={`w-full max-w-content min-w-0 min-h-screen bg-[var(--bg,#fff)] relative flex flex-col font-sans ${wide ? 'border-x border-[var(--line,#E8EBF0)]' : 'pb-16'}`}>
        {/* The app bar is only for phones (wider screens have the side navigation); Settings has its own header */}
        {!wide && activeTab !== 'settings' && <Navbar
          onTitleClick={() => setActiveTab(currentUser ? 'feed' : 'signin')}
          onOpenMessages={() => {
            setTargetMessageUser(null);
            setActiveTab('messages');
          }}
        />}

        <main className="flex-1 w-full overflow-x-hidden">
          <div key={pageKey} className={pageClass}>
          {activeTab === 'signin' && (
            <SignInPage onSuccessRedirect={() => checkAuth()} notice={authNotice} />
          )}

          {activeTab === 'signup' && !currentUser && (
            <OnboardingPage
              onComplete={() => checkAuth()}
              onRestart={() => {
                setAuthNotice(null);
                setActiveTab('signin');
              }}
            />
          )}

          {activeTab === 'feed' && currentUser && (
            <FeedPage
              currentUserId={currentUser.user.id}
              onNavigateToCompose={() => setActiveTab('post')}
              onViewAuthorProfile={handleViewAuthorProfile}
            />
          )}

          {activeTab === 'search' && currentUser && (
            <SearchPage
              currentUserId={currentUser.user.id}
              hasClass={!!currentUser.profile.class_id}
              hasCampus={!!currentUser.profile.campus_id}
              onViewAuthorProfile={handleViewAuthorProfile}
            />
          )}

          {activeTab === 'post' && currentUser && (
            <PostComposerPage
              currentUserId={currentUser?.user.id ?? ''}
              onPostCreated={() => setActiveTab('feed')}
              onCancel={() => setActiveTab('feed')}
            />
          )}

          {activeTab === 'messages' && currentUser && (
            <MessagesPage
              currentUserId={currentUser.user.id}
              initialTargetUser={targetMessageUser}
              onBack={() => goBack(() => setActiveTab('feed'))}
              onViewAuthorProfile={handleViewAuthorProfile}
            />
          )}

          {activeTab === 'settings' && currentUser && (
            <SettingsPage
              currentUser={currentUser}
              onProfileUpdated={handleProfileUpdated}
              onAccountDeleted={handleAccountDeleted}
              onLogout={handleLogout}
              onBack={() => goBack(() => { setProfileSubView('view'); setActiveTab('profile'); })}
              onEditProfile={() => { setViewUsername(currentUser.profile.username); setProfileSubView('edit'); setActiveTab('profile'); }}
            />
          )}

          {activeTab === 'profile' && currentUser && profileSubView === 'edit' && (
            <ProfileEditPage
              currentUser={currentUser}
              onProfileUpdated={handleProfileUpdated}
              onViewPublicProfile={(u) => {
                setViewUsername(u);
                setProfileSubView('view');
              }}
              onCancel={() => goBack(() => setProfileSubView('view'))}
            />
          )}

          {activeTab === 'profile' && currentUser && profileSubView === 'view' && (
            <ProfileViewPage
              initialUsername={viewUsername || currentUser.profile.username}
              currentUserId={currentUser.user.id}
              currentUsername={currentUser.profile.username}
              onNavigateToEditProfile={() => setProfileSubView('edit')}
              onOpenSettings={() => setActiveTab('settings')}
              onLogout={handleLogout}
              onOpenDirectMessage={(targetUser) => {
                setTargetMessageUser(targetUser);
                setActiveTab('messages');
              }}
            />
          )}

          {(!currentUser && activeTab !== 'signin' && activeTab !== 'signup') && (
            <SignInPage onSuccessRedirect={() => checkAuth()} />
          )}
          </div>
        </main>

        {/* Bottom tab bar: phones only */}
        {!wide && (
          <BottomTabBar
            activeTab={activeTab === 'settings' ? 'profile' : activeTab}
            setActiveTab={selectTab}
            isAuthenticated={!!currentUser}
          />
        )}

        {/* DEV-ONLY: remove before launch */}
        <DevBar currentUser={currentUser} onLogout={handleLogout} />
      </div>
    </div>
  );
}

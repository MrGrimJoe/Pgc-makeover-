/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { MeResponse } from '../shared/schema.ts';
import { Navbar } from './components/Navbar.tsx';
import { BottomTabBar, type AppTab } from './components/BottomTabBar.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { FeedPage } from './pages/FeedPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { PostComposerPage } from './pages/PostComposerPage.tsx';
import { ProfileEditPage } from './pages/ProfileEditPage.tsx';
import { ProfileViewPage } from './pages/ProfileViewPage.tsx';
import { MessagesPage } from './pages/MessagesPage.tsx';
// DEV-ONLY: remove before launch
import { DevBar } from './components/DevBar.tsx';

export default function App() {
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

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = (await res.json()) as MeResponse;
        setCurrentUser(data);
        setActiveTab('feed');
      } else {
        setCurrentUser(null);
        setActiveTab('signin');
      }
    } catch {
      setCurrentUser(null);
      setActiveTab('signin');
    } finally {
      setLoadingUser(false);
    }
  };

  useEffect(() => {
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
        <div className="w-full max-w-[430px] min-h-screen bg-[var(--bg,#fff)] p-4 flex flex-col items-center justify-center space-y-3">
          <div className="w-12 h-12 rounded-full skeleton-box mx-auto" />
          <div className="w-32 h-4 skeleton-box rounded mx-auto" />
          <div className="w-24 h-3 skeleton-box rounded mx-auto" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg2,#F8F9FC)] text-[var(--text,#17233A)] flex justify-center">
      <div className="w-full max-w-[430px] min-h-screen bg-[var(--bg,#fff)] relative flex flex-col pb-16 font-sans">
        <Navbar
          onTitleClick={() => setActiveTab(currentUser ? 'feed' : 'signin')}
          onOpenMessages={() => {
            setTargetMessageUser(null);
            setActiveTab('messages');
          }}
        />

        <main className="flex-1 w-full">
          {activeTab === 'signin' && (
            <SignInPage onSuccessRedirect={() => checkAuth()} />
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
              onViewAuthorProfile={handleViewAuthorProfile}
            />
          )}

          {activeTab === 'post' && currentUser && (
            <PostComposerPage
              onPostCreated={() => setActiveTab('feed')}
              onCancel={() => setActiveTab('feed')}
            />
          )}

          {activeTab === 'messages' && currentUser && (
            <MessagesPage
              currentUserId={currentUser.user.id}
              initialTargetUser={targetMessageUser}
              onBack={() => setActiveTab('feed')}
              onViewAuthorProfile={handleViewAuthorProfile}
            />
          )}

          {activeTab === 'profile' && currentUser && profileSubView === 'edit' && (
            <ProfileEditPage
              currentUser={currentUser}
              onProfileUpdated={handleProfileUpdated}
              onAccountDeleted={handleAccountDeleted}
              onLogout={handleLogout}
              onViewPublicProfile={(u) => {
                setViewUsername(u);
                setProfileSubView('view');
              }}
              onCancel={() => setProfileSubView('view')}
            />
          )}

          {activeTab === 'profile' && currentUser && profileSubView === 'view' && (
            <ProfileViewPage
              initialUsername={viewUsername || currentUser.profile.username}
              currentUserId={currentUser.user.id}
              currentUsername={currentUser.profile.username}
              onNavigateToEditProfile={() => setProfileSubView('edit')}
              onLogout={handleLogout}
              onOpenDirectMessage={(targetUser) => {
                setTargetMessageUser(targetUser);
                setActiveTab('messages');
              }}
            />
          )}

          {(!currentUser && activeTab !== 'signin') && (
            <SignInPage onSuccessRedirect={() => checkAuth()} />
          )}
        </main>

        {/* Bottom tab bar: icon-only, 4 tabs */}
        <BottomTabBar
          activeTab={activeTab}
          setActiveTab={(tab) => {
            if (tab === 'profile') {
              setViewUsername(currentUser?.profile.username || '');
              setProfileSubView('view');
            }
            setActiveTab(tab);
          }}
          isAuthenticated={!!currentUser}
        />

        {/* DEV-ONLY: remove before launch */}
        <DevBar currentUser={currentUser} onLogout={handleLogout} />
      </div>
    </div>
  );
}

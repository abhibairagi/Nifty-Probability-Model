import './globals.css';
import { DataProvider } from '@/components/DataProvider';
import Sidebar from '@/components/Sidebar';

export const metadata = {
  title: 'Expiry Probability Model',
  description: 'NIFTY expiry-day seller positioning, directional bias and strike OTM probabilities',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* apply the saved theme before first paint (no light/dark flash) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body>
        <DataProvider>
          <div className="shell">
            <Sidebar />
            <main className="content">{children}</main>
          </div>
        </DataProvider>
      </body>
    </html>
  );
}

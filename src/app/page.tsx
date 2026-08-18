import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export default async function Home() {
  // Console is the default; the sheet view is there for people who prefer it.
  const mode = (await cookies()).get('ui_mode')?.value;
  redirect(mode === 'sheet' ? '/sheets/model-1/surface' : '/console/model-1/rates');
}

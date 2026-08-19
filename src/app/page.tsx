import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/console/model-1/rates');
}

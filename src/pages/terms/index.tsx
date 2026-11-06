import { TermsContent } from '@/components/terms-gate';
export default function TermsPage() {
    return (
        <main className='neto-terms neto-terms--page'>
            <a href='/'>← Return to NetoAcademy</a>
            <h1>NetoAcademy Terms &amp; Conditions</h1>
            <TermsContent />
        </main>
    );
}

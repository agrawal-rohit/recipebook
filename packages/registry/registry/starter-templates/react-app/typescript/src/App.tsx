/**
 * Initial application screen for the React scaffold.
 * @returns The scaffold's starting page.
 */
export function App() {
	return (
		<main className="min-h-screen grid place-items-center p-8">
			<section className="max-w-xl space-y-4 text-center">
				<h1 className="text-4xl font-semibold text-zinc-900 dark:text-zinc-100">
					{{projectName}}
				</h1>
				<p className="text-zinc-600 dark:text-zinc-300">
					Start building your application here.
				</p>
			</section>
		</main>
	);
}

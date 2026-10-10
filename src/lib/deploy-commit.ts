// Fallback sledljivosti za CLI deploje (Task 41–43). Od Task 43 produkcija teče
// prek Vercel Git integration, kjer health uporablja VERCEL_GIT_COMMIT_SHA; ta
// placeholder ostane kot rezervni mehanizem (CI_DEPLOY_COMMIT v API verigi).
// Ne urejaj ročno — vrednosti so v build času prazne, razen pri rezervni CLI poti.
export const CI_DEPLOY_COMMIT = ''
export const CI_DEPLOY_RUN = ''

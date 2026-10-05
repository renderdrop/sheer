/** Golden output of the reference formatter for src/features/citations/format/fixtures.ts (`*x*` is italic). Reviewed by hand; change it only when a style rule changes. */
export const GOLDEN: Record<string, string> = {
  'apa7 book en':
    'Müller, A. M., & Schmidt, P. (2021). *Citing well* (2nd ed.). Iris Press. https://doi.org/10.1000/book.1',
  'apa7 book de':
    'Müller, A. M., & Schmidt, P. (2021). *Citing well* (2. Aufl.). Iris Press. https://doi.org/10.1000/book.1',
  'apa7 article en':
    'Müller, A. M. (2020). On quotations. *Journal of Sources*, *12*(3), 101–118. https://doi.org/10.1000/art.2',
  'apa7 article de':
    'Müller, A. M. (2020). On quotations. *Journal of Sources*, *12*(3), 101–118. https://doi.org/10.1000/art.2',
  'apa7 chapter en':
    'Müller, A. M., Schmidt, P., & Weber, J.-P. (2019). Quoting in chapters. In *The Handbook of Sources* (pp. 45–67). Iris Press.',
  'apa7 chapter de':
    'Müller, A. M., Schmidt, P., & Weber, J.-P. (2019). Quoting in chapters. In *The Handbook of Sources* (S. 45–67). Iris Press.',
  'apa7 report en': 'Statistisches Amt. (2022). *Annual report*. Statistisches Amt. https://example.org/report.pdf',
  'apa7 report de': 'Statistisches Amt. (2022). *Annual report*. Statistisches Amt. https://example.org/report.pdf',
  'apa7 webPage en':
    'Schmidt, P. (2023). *How to cite a page*. Example Site. Retrieved May 3, 2024, from https://example.org/cite',
  'apa7 webPage de':
    'Schmidt, P. (2023). *How to cite a page*. Example Site. Abgerufen am 3. Mai 2024 von https://example.org/cite',
  'apa7 thesis en':
    'Müller, A. M. (2018). *A study of quotations* [Thesis, Universität Leipzig]. https://example.org/thesis',
  'apa7 thesis de':
    'Müller, A. M. (2018). *A study of quotations* [Abschlussarbeit, Universität Leipzig]. https://example.org/thesis',
  'mla9 book en':
    'Müller, Anna Maria, and Peter Schmidt. *Citing well*. 2nd ed., Iris Press, 2021. https://doi.org/10.1000/book.1.',
  'mla9 book de':
    'Müller, Anna Maria, und Peter Schmidt. *Citing well*. 2. Aufl., Iris Press, 2021. https://doi.org/10.1000/book.1.',
  'mla9 article en':
    'Müller, Anna Maria. “On quotations.” *Journal of Sources*, vol. 12, no. 3, 2020, pp. 101–118. https://doi.org/10.1000/art.2.',
  'mla9 article de':
    'Müller, Anna Maria. „On quotations.“ *Journal of Sources*, Bd. 12, Nr. 3, 2020, S. 101–118. https://doi.org/10.1000/art.2.',
  'mla9 chapter en':
    'Müller, Anna Maria, et al. “Quoting in chapters.” *The Handbook of Sources*, Iris Press, 2019, pp. 45–67.',
  'mla9 chapter de':
    'Müller, Anna Maria, u. a. „Quoting in chapters.“ *The Handbook of Sources*, Iris Press, 2019, S. 45–67.',
  'mla9 report en': 'Statistisches Amt. *Annual report*. Statistisches Amt, 2022. https://example.org/report.pdf.',
  'mla9 report de': 'Statistisches Amt. *Annual report*. Statistisches Amt, 2022. https://example.org/report.pdf.',
  'mla9 webPage en':
    'Schmidt, Peter. “How to cite a page.” *Example Site*, 2023, https://example.org/cite. Accessed 3 May 2024.',
  'mla9 webPage de':
    'Schmidt, Peter. „How to cite a page.“ *Example Site*, 2023, https://example.org/cite. Abgerufen am 3. Mai 2024.',
  'mla9 thesis en':
    'Müller, Anna Maria. *A study of quotations*. 2018. Universität Leipzig, Thesis. https://example.org/thesis.',
  'mla9 thesis de':
    'Müller, Anna Maria. *A study of quotations*. 2018. Universität Leipzig, Abschlussarbeit. https://example.org/thesis.',
  'chicago17AuthorDate book en':
    'Müller, Anna Maria, and Peter Schmidt. 2021. *Citing well*. 2nd ed. Berlin: Iris Press. https://doi.org/10.1000/book.1.',
  'chicago17AuthorDate book de':
    'Müller, Anna Maria und Peter Schmidt. 2021. *Citing well*. 2. Aufl. Berlin: Iris Press. https://doi.org/10.1000/book.1.',
  'chicago17AuthorDate article en':
    'Müller, Anna Maria. 2020. “On quotations.” *Journal of Sources* 12(3): 101–118. https://doi.org/10.1000/art.2.',
  'chicago17AuthorDate article de':
    'Müller, Anna Maria. 2020. „On quotations.“ *Journal of Sources* 12(3): 101–118. https://doi.org/10.1000/art.2.',
  'chicago17AuthorDate chapter en':
    'Müller, Anna Maria, Peter Schmidt, and Jean-Paul Weber. 2019. “Quoting in chapters.” In *The Handbook of Sources*, 45–67. 3rd ed. Hamburg: Iris Press.',
  'chicago17AuthorDate chapter de':
    'Müller, Anna Maria, Peter Schmidt und Jean-Paul Weber. 2019. „Quoting in chapters.“ In *The Handbook of Sources*, 45–67. 3. Aufl. Hamburg: Iris Press.',
  'chicago17AuthorDate report en':
    'Statistisches Amt. 2022. *Annual report*. Wiesbaden: Statistisches Amt. https://example.org/report.pdf.',
  'chicago17AuthorDate report de':
    'Statistisches Amt. 2022. *Annual report*. Wiesbaden: Statistisches Amt. https://example.org/report.pdf.',
  'chicago17AuthorDate webPage en':
    'Schmidt, Peter. 2023. “How to cite a page.” *Example Site*. Accessed May 3, 2024. https://example.org/cite.',
  'chicago17AuthorDate webPage de':
    'Schmidt, Peter. 2023. „How to cite a page.“ *Example Site*. Abgerufen am 3. Mai 2024. https://example.org/cite.',
  'chicago17AuthorDate thesis en':
    'Müller, Anna Maria. 2018. “A study of quotations.” Thesis, Universität Leipzig, Leipzig. https://example.org/thesis.',
  'chicago17AuthorDate thesis de':
    'Müller, Anna Maria. 2018. „A study of quotations.“ Abschlussarbeit, Universität Leipzig, Leipzig. https://example.org/thesis.',
  'dinIso690 book en':
    'MÜLLER, Anna Maria; SCHMIDT, Peter, 2021. *Citing well*. 2nd ed. Berlin: Iris Press. DOI 10.1000/book.1',
  'dinIso690 book de':
    'MÜLLER, Anna Maria; SCHMIDT, Peter, 2021. *Citing well*. 2. Aufl. Berlin: Iris Press. DOI 10.1000/book.1',
  'dinIso690 article en':
    'MÜLLER, Anna Maria, 2020. On quotations. *Journal of Sources*. vol. 12, no. 3, pp. 101–118. DOI 10.1000/art.2',
  'dinIso690 article de':
    'MÜLLER, Anna Maria, 2020. On quotations. *Journal of Sources*. Bd. 12, Nr. 3, S. 101–118. DOI 10.1000/art.2',
  'dinIso690 chapter en':
    'MÜLLER, Anna Maria; SCHMIDT, Peter; WEBER, Jean-Paul, 2019. Quoting in chapters. In: *The Handbook of Sources*. 3rd ed. Hamburg: Iris Press, pp. 45–67.',
  'dinIso690 chapter de':
    'MÜLLER, Anna Maria; SCHMIDT, Peter; WEBER, Jean-Paul, 2019. Quoting in chapters. In: *The Handbook of Sources*. 3. Aufl. Hamburg: Iris Press, S. 45–67.',
  'dinIso690 report en':
    'STATISTISCHES AMT, 2022. *Annual report*. Wiesbaden: Statistisches Amt. Available from: https://example.org/report.pdf',
  'dinIso690 report de':
    'STATISTISCHES AMT, 2022. *Annual report*. Wiesbaden: Statistisches Amt. Verfügbar unter: https://example.org/report.pdf',
  'dinIso690 webPage en':
    'SCHMIDT, Peter, 2023. *How to cite a page* [online]. Example Site. [accessed 2024-05-03]. Available from: https://example.org/cite',
  'dinIso690 webPage de':
    'SCHMIDT, Peter, 2023. *How to cite a page* [online]. Example Site. [abgerufen am 2024-05-03]. Verfügbar unter: https://example.org/cite',
  'dinIso690 thesis en':
    'MÜLLER, Anna Maria, 2018. *A study of quotations*. Thesis. Leipzig: Universität Leipzig. Available from: https://example.org/thesis',
  'dinIso690 thesis de':
    'MÜLLER, Anna Maria, 2018. *A study of quotations*. Abschlussarbeit. Leipzig: Universität Leipzig. Verfügbar unter: https://example.org/thesis',
};

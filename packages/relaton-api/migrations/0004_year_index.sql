-- Page one of the search sorts by publication date over the whole
-- corpus; without this index every unfiltered hit sorted 861k rows.
CREATE INDEX idx_documents_year_docid ON documents (year DESC, docid ASC);

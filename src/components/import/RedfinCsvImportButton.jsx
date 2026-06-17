import React, { useRef, useState } from 'react';
import Papa from 'papaparse';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import RedfinImportSummary from './RedfinImportSummary';
import { createRouteFromRedfinImport, prepareRedfinCsvImport } from './redfinCsvImport';

export default function RedfinCsvImportButton({ user, startLocation, onRouteCreated, children, className }) {
  const inputRef = useRef(null);
  const queryClient = useQueryClient();
  const [pendingImport, setPendingImport] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  const openPicker = () => inputRef.current?.click();

  const handleFile = (file) => {
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        if (results.errors?.length) {
          toast.error('Unable to read this file. Please upload a valid CSV file.');
          return;
        }
        try {
          const prepared = await prepareRedfinCsvImport(results.data, file.name);
          if (!prepared) {
            toast.error('This import button supports Redfin CSV exports. Use Setup for other formats.');
            return;
          }
          setPendingImport(prepared);
        } catch (error) {
          toast.error(error.message || 'Unable to read this file. Please upload a valid CSV file.');
        }
      },
      error: () => toast.error('Unable to read this file. Please upload a valid CSV file.')
    });
  };

  const handleCreate = async () => {
    if (!pendingImport) return;
    setIsSaving(true);
    try {
      const route = await createRouteFromRedfinImport(pendingImport, { user, startLocation });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] }),
        queryClient.invalidateQueries({ queryKey: ['masterProperties'] }),
        queryClient.invalidateQueries({ queryKey: ['localProperties'] })
      ]);
      setPendingImport(null);
      onRouteCreated?.(route);
      toast.success(`Created route: ${route.name}`);
    } catch (error) {
      toast.error(error.message || 'Import failed');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          handleFile(file);
        }}
      />
      <button type="button" onClick={openPicker} className={className}>
        {children}
      </button>
      <RedfinImportSummary
        importBatch={pendingImport}
        isSaving={isSaving}
        onCancel={() => setPendingImport(null)}
        onCreateRoute={handleCreate}
      />
    </>
  );
}